'use strict'
// Runs every account connection: the login queue (with a delay between
// logins), auto-reconnect with backoff, version auto-detect, and chat routing.
const { EventEmitter } = require('events')
const mc = require('minecraft-protocol')
const { Session } = require('./session')
const { findVersion, versionForProtocol } = require('./versions')
const { toSegments, plainText } = require('./chat-format')
const { maskSecrets } = require('./secrets')

const ACTIVE = new Set(['queued', 'signing_in', 'connecting', 'logging_in', 'online'])
const DETECT_CACHE_MS = 5 * 60 * 1000

function rand (maxSec) {
  return Math.random() * Math.max(0, maxSec) * 1000
}

class Manager extends EventEmitter {
  constructor ({ accounts, getSettings, getServer }) {
    super()
    this.accounts = accounts
    this.getSettings = getSettings
    this.getServer = getServer
    this.slots = new Map() // accountId -> slot
    this.queue = []
    this.queueTimer = null
    this.nextLoginAt = 0
    this.detectCache = new Map()
    this.history = []
    this.lineSeq = 0
    this.pendingLines = []
    this.flushTimer = null
    this.slotsTimer = null
    this.statsTimer = setInterval(() => { if (this.onlineCount() > 0) this._slotsChanged() }, 2000)
  }

  // ------------------------------------------------------------ slots
  _slot (id) {
    let s = this.slots.get(id)
    if (!s) {
      s = { id, status: 'offline', message: '', attempts: 0, nextAttemptAt: 0, session: null, timer: null, server: null, versionId: null }
      this.slots.set(id, s)
    }
    return s
  }

  _set (slot, status, message) {
    slot.status = status
    if (message !== undefined) slot.message = message
    this._slotsChanged()
  }

  _slotsChanged () {
    if (this.slotsTimer) return
    this.slotsTimer = setTimeout(() => {
      this.slotsTimer = null
      this.emit('slots', this.publicSlots())
    }, 100)
  }

  publicSlots () {
    const out = {}
    for (const acc of this.accounts.accounts) {
      const s = this._slot(acc.id)
      const qIndex = this.queue.indexOf(acc.id)
      out[acc.id] = {
        status: s.status,
        message: s.message,
        attempts: s.attempts,
        nextAttemptAt: s.nextAttemptAt || 0,
        queuePosition: qIndex === -1 ? 0 : qIndex + 1,
        server: s.server ? `${s.server.host}${s.server.port !== 25565 ? ':' + s.server.port : ''}` : null,
        serverId: s.server?.id || null,
        version: s.versionId,
        stats: s.session ? s.session.publicStats() : null
      }
    }
    return out
  }

  onlineCount () {
    let n = 0
    for (const s of this.slots.values()) if (s.status === 'online') n++
    return n
  }

  queueInfo () {
    return { length: this.queue.length, nextLoginAt: this.queue.length ? this.nextLoginAt : 0 }
  }

  // ------------------------------------------------------------ connect / disconnect
  connect (ids) {
    const server = this.getServer()
    if (!server) throw new Error('Pick or add a server first.')
    let added = 0
    for (const id of ids) {
      const acc = this.accounts.get(id)
      if (!acc) continue
      const slot = this._slot(id)
      if (ACTIVE.has(slot.status)) continue
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null }
      slot.manualStop = false
      slot.attempts = 0
      slot.nextAttemptAt = 0
      this._enqueue(slot, 'Waiting for login slot')
      added++
    }
    this._processQueue()
    return added
  }

  disconnect (ids) {
    for (const id of ids) {
      const slot = this.slots.get(id)
      if (!slot) continue
      slot.manualStop = true
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null }
      this.queue = this.queue.filter(q => q !== id)
      if (!slot.session) slot.reconnectAfterStop = false
      slot.nextAttemptAt = 0
      if (slot.session) slot.session.stop()
      else this._set(slot, 'offline', 'Disconnected')
      if (slot.connectAbort) slot.connectAbort.aborted = true
    }
    this._slotsChanged()
  }

  disconnectAll () {
    this.disconnect([...this.slots.keys()])
  }

  /** Disconnect and reconnect (e.g. after switching server or version). */
  reconnect (ids) {
    let count = 0
    for (const id of ids) {
      const slot = this.slots.get(id)
      if (!slot || slot.status === 'offline' || slot.status === 'needs_sign_in') continue
      count++
      if (slot.session) {
        // queue it again once the current connection has fully closed
        slot.reconnectAfterStop = true
        this.disconnect([id])
      } else {
        this.disconnect([id])
        this.connect([id])
      }
    }
    return count
  }

  _enqueue (slot, message) {
    if (!this.queue.includes(slot.id)) this.queue.push(slot.id)
    this._set(slot, 'queued', message)
  }

  _processQueue () {
    if (this.queueTimer || this.queue.length === 0) return
    const wait = Math.max(0, this.nextLoginAt - Date.now())
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null
      const id = this.queue.shift()
      if (id) {
        const slot = this._slot(id)
        if (slot.status === 'queued') {
          const settings = this.getSettings()
          this.nextLoginAt = Date.now() + settings.loginDelaySec * 1000 + rand(settings.loginJitterSec)
          this._start(slot)
        }
      }
      this._slotsChanged()
      this._processQueue()
    }, wait)
  }

  async _start (slot) {
    const acc = this.accounts.get(slot.id)
    const server = this.getServer()
    if (!acc || !server) return this._set(slot, 'offline', !server ? 'No server selected' : 'Account removed')
    const token = { aborted: false }
    slot.connectAbort = token
    slot.server = { ...server }
    slot.kickReason = null
    this._set(slot, 'signing_in', 'Signing in')

    let auth
    try {
      auth = await this.accounts.getSession(slot.id)
    } catch (e) {
      if (token.aborted) return
      if (e.needsSignIn) {
        this._line(slot.id, 'event', `${acc.name}: ${e.message}`, 'error')
        return this._set(slot, 'needs_sign_in', e.message)
      }
      return this._afterFailure(slot, e.message || 'Sign-in failed', { wasOnline: false })
    }
    if (token.aborted) return

    let version
    try {
      version = await this._resolveVersion(server)
    } catch (e) {
      if (token.aborted) return
      return this._afterFailure(slot, e.message, { wasOnline: false, fatal: !!e.fatal })
    }
    if (token.aborted) return

    slot.versionId = version.id
    this._set(slot, 'connecting', `Connecting to ${server.host}`)
    const session = new Session({
      account: { id: acc.id, name: auth.profile.name },
      server: slot.server,
      version,
      auth,
      settings: this.getSettings()
    })
    slot.session = session
    session.on('state', (state) => {
      if (state === 'logging_in') this._set(slot, 'logging_in', 'Logging in')
      if (state === 'online') {
        this._set(slot, 'online', `Online on ${server.host}`)
        this._line(slot.id, 'event', `${auth.profile.name} joined ${server.host} (${version.id})`, 'good')
      }
    })
    session.on('chat', ({ segments, text, position }) => this._line(slot.id, 'chat', text, position, segments))
    session.on('event', ({ text, level }) => this._line(slot.id, 'event', `${auth.profile.name}: ${text}`, level))
    session.on('spawn', () => this.emit('spawn', slot.id, session))
    session.on('death', () => this.emit('death', slot.id))
    session.on('health', (health, food) => this.emit('health', slot.id, health, food))
    session.on('window', ({ title }) => this.emit('window', slot.id, title))
    session.on('menu', ({ title }) => {
      this._line(slot.id, 'event', `${auth.profile.name}: the server opened a menu ("${title}"). Open POV to click it.`, 'info')
      this.emit('menu', slot.id, title)
    })
    session.on('end', (info) => {
      if (slot.session === session) slot.session = null
      this._onSessionEnd(slot, info, auth.profile.name)
      this.emit('offline', slot.id)
    })
    session.start()
  }

  async _resolveVersion (server) {
    if (server.version && server.version !== 'auto') {
      const v = findVersion(server.version)
      if (!v) throw Object.assign(new Error(`Unsupported version ${server.version}`), { fatal: true })
      return v
    }
    const key = `${server.host}:${server.port}`
    const hit = this.detectCache.get(key)
    if (hit && Date.now() - hit.at < DETECT_CACHE_MS) return hit.version
    if (hit && hit.promise) return hit.promise
    const promise = (async () => {
      const info = await this.ping(server.host, server.port)
      const v = versionForProtocol(info.protocol)
      if (!v) {
        const err = new Error(`The server reports ${info.versionName || 'protocol ' + info.protocol}, which MineDeck can't auto-match. Pick a version for this server manually.`)
        err.fatal = true
        throw err
      }
      return v
    })()
    this.detectCache.set(key, { promise, at: 0 })
    try {
      const version = await promise
      this.detectCache.set(key, { version, at: Date.now() })
      return version
    } catch (e) {
      this.detectCache.delete(key)
      throw e
    }
  }

  /** Server list ping: MOTD, players, version. */
  async ping (host, port) {
    const started = Date.now()
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Ping timed out')), 10000)
      mc.ping({ host, port, closeTimeout: 9000, noPongTimeout: 9000 }, (err, result) => {
        clearTimeout(t)
        if (err) reject(err)
        else resolve(result)
      })
    }).catch((e) => { throw new Error(pingError(e)) })
    // 1.7+ servers answer with JSON; very old servers with a legacy format
    const protocol = Number(res?.version?.protocol ?? res?.protocol)
    const versionName = String(res?.version?.name ?? res?.version ?? '').slice(0, 80)
    let motd = res?.description ?? res?.motd ?? ''
    let motdSegments
    try { motdSegments = toSegments(motd) } catch { motdSegments = [] }
    motd = plainText(motdSegments)
    const favicon = typeof res?.favicon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(res.favicon) && res.favicon.length < 200000
      ? res.favicon
      : null
    return {
      protocol: Number.isFinite(protocol) ? protocol : null,
      versionName,
      motd,
      motdSegments,
      players: { online: Number(res?.players?.online) || 0, max: Number(res?.players?.max) || 0 },
      favicon,
      latency: Number(res?.latency) || Date.now() - started,
      matchedVersion: Number.isFinite(protocol) ? (versionForProtocol(protocol)?.id || null) : null
    }
  }

  _onSessionEnd (slot, info, name) {
    const settings = this.getSettings()
    this._line(slot.id, 'event', `${name}: ${info.message}`, info.kicked ? 'error' : (info.manual ? 'info' : 'warn'))
    if (info.manual || slot.manualStop) {
      slot.attempts = 0
      if (slot.reconnectAfterStop) {
        slot.reconnectAfterStop = false
        slot.manualStop = false
        this._enqueue(slot, 'Waiting for login slot')
        return this._processQueue()
      }
      return this._set(slot, 'offline', 'Disconnected')
    }
    // a connection that stayed up a while starts its retry count over
    if (info.wasOnline && info.onlineMs > 120000) slot.attempts = 0
    const reason = (info.kickReason || info.message || '').toLowerCase()
    const stopWord = (settings.reconnectStopWords || []).find(w => w && reason.includes(w.toLowerCase()))
    if (stopWord) {
      this._line(slot.id, 'event', `${name}: not reconnecting (kick reason contains "${stopWord}")`, 'warn')
      return this._set(slot, 'stopped', info.message)
    }
    this._afterFailure(slot, info.message, info)
  }

  _afterFailure (slot, message, info = {}) {
    const settings = this.getSettings()
    slot.session = null
    if (slot.manualStop) return this._set(slot, 'offline', 'Disconnected')
    if (info.fatal || !settings.autoReconnect) return this._set(slot, 'stopped', message)
    if (settings.reconnectMaxAttempts > 0 && slot.attempts >= settings.reconnectMaxAttempts) {
      return this._set(slot, 'stopped', `${message} (gave up after ${slot.attempts} tries)`)
    }
    const base = settings.reconnectDelaySec * 1000
    const delay = Math.min(settings.reconnectMaxDelaySec * 1000, base * Math.pow(2, Math.min(slot.attempts, 16))) + rand(Math.min(5, settings.reconnectDelaySec))
    slot.attempts++
    slot.nextAttemptAt = Date.now() + delay
    this._set(slot, 'waiting', message)
    slot.timer = setTimeout(() => {
      slot.timer = null
      slot.nextAttemptAt = 0
      if (slot.manualStop || slot.status !== 'waiting') return
      this._enqueue(slot, `Reconnecting (try ${slot.attempts})`)
      this._processQueue()
    }, delay)
  }

  // ------------------------------------------------------------ chat
  _line (accountId, kind, text, positionOrLevel, segments) {
    const acc = this.accounts.get(accountId)
    const line = {
      id: ++this.lineSeq,
      time: Date.now(),
      acc: accountId,
      name: acc ? acc.name : '?',
      kind, // 'chat' | 'event' | 'sent'
      level: kind === 'chat' ? undefined : positionOrLevel,
      pos: kind === 'chat' ? positionOrLevel : undefined,
      text: String(text).slice(0, 4000),
      seg: segments || null
    }
    const max = this.getSettings().chatMaxLines || 3000
    this.history.push(line)
    if (this.history.length > max) this.history.splice(0, this.history.length - max)
    this.pendingLines.push(line)
    this.emit('line', line)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        const batch = this.pendingLines
        this.pendingLines = []
        this.emit('lines', batch)
      }, 80)
    }
  }

  /**
   * Sends text (chat or /command) from each online account in `ids`,
   * spaced out by the "send delay" setting.
   */
  sendChat (text, ids) {
    const settings = this.getSettings()
    const msg = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 1000)
    if (!msg) return { sent: 0, skipped: 0 }
    const targets = ids.map(id => this.slots.get(id)).filter(s => s && s.status === 'online' && s.session)
    const skipped = ids.length - targets.length
    targets.forEach((slot, i) => {
      setTimeout(() => {
        if (!slot.session || slot.status !== 'online') return
        try {
          slot.session.send(msg)
          this._line(slot.id, 'sent', maskSecrets(msg), 'info') // never show or log login passwords
        } catch (e) {
          this._line(slot.id, 'event', `${this.accounts.get(slot.id)?.name || '?'}: could not send (${e.message})`, 'warn')
        }
      }, i * settings.sendDelayMs)
    })
    return { sent: targets.length, skipped }
  }

  /** a macro's chat message or command, sent right away from one account */
  sendFrom (id, text) {
    const slot = this.slots.get(id)
    const msg = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 1000)
    if (!msg || !slot || slot.status !== 'online' || !slot.session) return false
    slot.session.send(msg)
    this._line(slot.id, 'sent', maskSecrets(msg), 'info') // never show or log login passwords
    return true
  }

  /** a line in the chat window about one account (used by macros) */
  note (id, text, level = 'info') {
    if (this.slots.has(id) || this.accounts.get(id)) this._line(id, 'event', text, level)
  }

  players (id) {
    const slot = this.slots.get(id)
    return slot?.session ? slot.session.players : []
  }

  applySettings () {
    const settings = this.getSettings()
    for (const slot of this.slots.values()) if (slot.session) slot.session.applySettings(settings)
  }

  forget (id) {
    this.disconnect([id])
    this.slots.delete(id)
  }

  shutdown () {
    clearInterval(this.statsTimer)
    for (const slot of this.slots.values()) {
      slot.manualStop = true
      if (slot.timer) clearTimeout(slot.timer)
      if (slot.session) slot.session.stop()
    }
    this.queue = []
    if (this.queueTimer) clearTimeout(this.queueTimer)
  }
}

function pingError (e) {
  const code = e && e.code
  if (code === 'ECONNREFUSED') return 'Connection refused (is the server online and the port right?)'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Server address not found'
  if (code === 'ETIMEDOUT') return 'Connection timed out'
  return (e && e.message ? e.message : String(e)).slice(0, 200)
}

module.exports = { Manager }
