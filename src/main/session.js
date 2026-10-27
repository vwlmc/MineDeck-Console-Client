'use strict'
// One account connected to one server. Uses mineflayer for 1.8 - 26.1.x and a
// small minecraft-protocol client for 1.7.10 (mineflayer starts at 1.8).
const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')
const mc = require('minecraft-protocol')
const mcData = require('minecraft-data')
const nbt = require('prismarine-nbt')
const { toSegments, plainText } = require('./chat-format')
const { textSegments } = require('./pov')

// Hands our own sign-in result to minecraft-protocol instead of letting it
// run its built-in login. Tokens are given only to the protocol client, which
// sends the access token to Mojang's session server (never to the game server).
function authHook (auth) {
  return (client, options) => {
    client.username = auth.profile.name
    client.session = {
      accessToken: auth.accessToken,
      selectedProfile: { id: auth.profile.id, name: auth.profile.name },
      availableProfile: [{ id: auth.profile.id, name: auth.profile.name }]
    }
    if (auth.profileKeys) client.profileKeys = auth.profileKeys
    options.accessToken = auth.accessToken
    options.haveCredentials = true
    options.connect(client)
  }
}

// Some packet fields are "mappers" (wire numbers with names) in one version's
// protocol data and plain numbers in another, and mineflayer sometimes writes
// the number where this version expects the name (for example the respawn
// packet on 1.7 / 1.8, or the arm swing on 26.1). A packet that can't be encoded
// breaks the whole connection, so numbers are translated to names here.
const mapperCache = new Map()
function mapperFields (data) {
  const key = data.version.minecraftVersion
  if (mapperCache.has(key)) return mapperCache.get(key)
  const out = {}
  const types = data.protocol?.play?.toServer?.types || {}
  for (const [name, def] of Object.entries(types)) {
    if (!name.startsWith('packet_') || !Array.isArray(def) || def[0] !== 'container' || !Array.isArray(def[1])) continue
    for (const field of def[1]) {
      const t = field && field.type
      if (Array.isArray(t) && t[0] === 'mapper' && t[1] && t[1].mappings) {
        (out[name.slice(7)] ||= {})[field.name] = t[1].mappings
      }
    }
  }
  mapperCache.set(key, out)
  return out
}

function installWriteFixes (client, data) {
  const fields = mapperFields(data)
  const write = client.write.bind(client)
  client.write = (name, params) => {
    const mappers = client.state === 'play' && params && typeof params === 'object' ? fields[name] : null
    if (mappers) {
      params = { ...params }
      // mineflayer writes { actionId } even on versions where the field is called payload
      if (name === 'client_command' && mappers.payload && params.payload === undefined && params.actionId !== undefined) {
        params.payload = params.actionId
        delete params.actionId
      }
      for (const [field, mappings] of Object.entries(mappers)) {
        const v = params[field]
        if (typeof v !== 'number') continue
        const named = mappings[String(v)] ?? mappings['0x' + v.toString(16).padStart(2, '0')]
        if (named !== undefined) params[field] = named
      }
    }
    return write(name, params)
  }
}

// minecraft-protocol hands each received packet to its listeners from inside
// its stream pipeline. If one listener throws (for example mineflayer meeting a
// packet layout it doesn't expect), the pipeline stops and the connection
// silently stops receiving anything. Catch such errors per packet instead.
function guardPacketHandlers (client, onError) {
  const emit = client.emit
  client.emit = function (event, ...args) {
    try {
      return emit.call(this, event, ...args)
    } catch (e) {
      try { onError(event, e) } catch { }
      return true
    }
  }
}

function reasonToText (reason, lang) {
  if (reason == null) return ''
  let value = reason
  if (typeof reason === 'string') {
    try { value = JSON.parse(reason) } catch { value = reason }
  } else if (typeof reason === 'object' && 'type' in reason && 'value' in reason) {
    // 1.20.3+ sends text components as NBT
    try { value = nbt.simplify(reason) } catch { value = '' }
  }
  try {
    return plainText(toSegments(value, lang)).trim().slice(0, 500)
  } catch {
    return String(reason).slice(0, 500)
  }
}

function describeError (err) {
  if (!err) return 'Unknown error'
  const code = err.code
  if (code === 'ECONNREFUSED') return 'Connection refused (is the server online and the address/port right?)'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Server address not found'
  if (code === 'ETIMEDOUT') return 'Connection timed out'
  if (code === 'ECONNRESET') return 'Connection reset by the server'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Server unreachable (network problem)'
  const msg = String(err.message || err)
  if (/Failed to verify username|Invalid session|session/i.test(msg) && /403|401|verify|session/i.test(msg)) {
    return 'Mojang rejected the session. Try signing this account in again.'
  }
  if (/^Serialization error for ([\w.]+)/i.test(msg)) {
    const packet = msg.match(/^Serialization error for ([\w.]+)/i)[1]
    return `MineDeck couldn't encode a packet (${packet}). This is a MineDeck bug; please report it.`
  }
  return msg.slice(0, 300)
}

class Session extends EventEmitter {
  /**
   * @param {object} o
   * @param {{id:string,name:string}} o.account
   * @param {{host:string,port:number,joinCommands:string[]}} o.server
   * @param {{id:string,dataVersion:string,engine:string}} o.version
   * @param {{accessToken:string,profile:{id:string,name:string},profileKeys:object|null}} o.auth
   * @param {object} o.settings
   */
  constructor ({ account, server, version, auth, settings }) {
    super()
    this.account = account
    this.server = server
    this.version = version
    this.settings = settings
    this.auth = auth
    this.data = mcData(version.dataVersion)
    this.lang = this.data?.language || null
    this.state = 'connecting'
    this.loggedIn = false
    this.ended = false
    this.kickReason = null
    this.lastError = null
    this.timers = new Set()
    this.stats = { health: null, food: null, ping: null, position: null, dimension: null, gameMode: null, players: 0 }
    this.players = []
    this.startedAt = Date.now()
    this.onlineAt = null
  }

  _timeout (fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn() }, ms)
    this.timers.add(t)
    return t
  }

  _interval (fn, ms) {
    const t = setInterval(fn, ms)
    this.timers.add(t)
    return t
  }

  _clearTimers () {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t) }
    this.timers.clear()
  }

  _event (text, level = 'info') {
    this.emit('event', { text, level })
  }

  _chat (component, position = 'chat') {
    if (this.ended) return
    if (position === 'game_info' && !this.settings.chatShowActionBar) return
    const segments = toSegments(component, this.lang)
    const text = plainText(segments)
    if (!text.trim()) return
    this.emit('chat', { segments, text, position })
  }

  start () {
    const timeoutMs = (this.settings.connectTimeoutSec || 30) * 1000
    this._timeout(() => {
      if (!this.loggedIn && !this.ended) this._fail(new Error(`Timed out joining the server after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    try {
      if (this.version.engine === 'legacy') this._startLegacy()
      else this._startMineflayer()
    } catch (e) {
      this._fail(e)
    }
  }

  // ---------------------------------------------------------------- 1.8+
  _startMineflayer () {
    const bot = mineflayer.createBot({
      host: this.server.host,
      port: this.server.port,
      username: this.auth.profile.name,
      version: this.version.dataVersion,
      auth: authHook(this.auth),
      disableChatSigning: !this.auth.profileKeys,
      hideErrors: true,
      logErrors: false,
      respawn: !!this.settings.autoRespawn,
      viewDistance: this.settings.viewDistance || 'tiny',
      defaultChatPatterns: false,
      checkTimeoutInterval: 45 * 1000,
      brand: 'vanilla'
    })
    this.bot = bot
    this.client = bot._client
    installWriteFixes(bot._client, this.data)
    guardPacketHandlers(bot._client, (event, e) => this._handlerError(event, e))

    bot._client.on('connect', () => { if (!this.ended) this._setState('logging_in') })
    bot.once('login', () => this._onLoggedIn())
    bot.once('spawn', () => this._onSpawn())
    bot.on('message', (msg, position) => this._chat(msg, position))
    bot.on('kicked', (reason) => {
      this.kickReason = reasonToText(reason, this.lang) || 'Kicked'
    })
    bot.on('death', () => { this._event(this.settings.autoRespawn ? 'Died, respawning' : 'Died', 'warn'); this.emit('death') })
    bot.on('health', () => { this.stats.health = bot.health; this.stats.food = bot.food; this.emit('health', bot.health, bot.food) })
    // Resource packs are answered here rather than with mineflayer's helpers:
    // on 1.8 and 1.9 those send the answer before they know the pack's hash, and
    // "decline" sends a malformed packet on 1.8, 1.9 and 1.20.3+. Either one
    // breaks the connection (see _onClientError).
    bot._client.on('resource_pack_send', (packet) => {
      if (this.data.supportFeature('resourcePackUsesUUID')) this._answerResourcePack({ uuid: packet.uuid })
      else if (this.data.supportFeature('resourcePackUsesHash')) this._answerResourcePack({ hash: typeof packet.hash === 'string' ? packet.hash : '' })
      else this._answerResourcePack({})
    })
    bot._client.on('add_resource_pack', (packet) => this._answerResourcePack({ uuid: packet.uuid }))
    // a server menu (chest GUI, "click to confirm", ...): let the user know they can answer it in POV
    bot.on('windowOpen', (w) => {
      let title = ''
      try { title = plainText(textSegments(w.title, this.lang)).trim().slice(0, 80) } catch { }
      title = title || 'Menu'
      this.emit('window', { title }) // every time (macros wait for menus)
      // some servers reopen the same menu over and over: say it once in a while
      const now = Date.now()
      if (title === this.lastMenu?.title && now - this.lastMenu.at < 15000) return
      this.lastMenu = { title, at: now }
      this.emit('menu', { title })
    })
    bot.on('error', (err) => this._onClientError(err))
    bot.on('end', (reason) => this._onEnd(reason))
  }

  // ---------------------------------------------------------------- 1.7.10
  _startLegacy () {
    const client = mc.createClient({
      host: this.server.host,
      port: this.server.port,
      username: this.auth.profile.name,
      version: this.version.dataVersion,
      auth: authHook(this.auth),
      hideErrors: true,
      checkTimeoutInterval: 45 * 1000
    })
    this.client = client
    installWriteFixes(client, this.data)
    guardPacketHandlers(client, (event, e) => this._handlerError(event, e))
    client.on('connect', () => { if (!this.ended) this._setState('logging_in') })
    client.once('login', (packet) => {
      this.entityId = packet.entityId
      this._onLoggedIn()
      this._onSpawn()
      // let the server know we're still here (no movement, so no position checks)
      this._interval(() => { try { client.write('flying', { onGround: true }) } catch { } }, 1000)
    })
    client.on('chat', (packet) => {
      let json
      try { json = JSON.parse(packet.message) } catch { json = packet.message }
      this._chat(json, 'chat')
    })
    client.on('kick_disconnect', (packet) => {
      this.kickReason = reasonToText(packet.reason, this.lang) || 'Kicked'
    })
    client.on('update_health', (p) => {
      this.stats.health = p.health
      this.stats.food = p.food
      this.emit('health', p.health, p.food)
      if (p.health <= 0) {
        this.emit('death')
        this._event(this.settings.autoRespawn ? 'Died, respawning' : 'Died', 'warn')
        if (this.settings.autoRespawn) this._timeout(() => { try { client.write('client_command', { payload: 'perform_respawn' }) } catch { } }, 500)
      }
    })
    client.on('position', (p) => { this.stats.position = { x: p.x, y: p.y - 1.62, z: p.z } })
    const legacyPlayers = new Map()
    client.on('player_info', (p) => {
      if (p.online) legacyPlayers.set(p.playerName, { name: p.playerName, ping: p.ping })
      else legacyPlayers.delete(p.playerName)
      this.players = [...legacyPlayers.values()]
      this.stats.players = this.players.length
      if (p.playerName === this.auth.profile.name) this.stats.ping = p.ping
    })
    client.on('error', (err) => this._onClientError(err))
    client.on('end', (reason) => this._onEnd(reason))
  }

  // ---------------------------------------------------------------- shared
  _onClientError (err) {
    this.lastError = err
    // connection errors before login never reach 'end' on some versions
    if (!this.loggedIn) return this._fail(err)
    // After a packet fails to encode, minecraft-protocol can't send anything
    // more on this connection: chat would silently go nowhere until the server
    // times out. Close it now so auto-reconnect can take over.
    if (/Serialization error/i.test(String(err && err.message)) || this._pipelineBroken()) this._fail(err)
  }

  // a packet we couldn't process: skip it, keep the connection, say so once per packet type
  _handlerError (event, err) {
    console.error(`[session] error while handling "${event}":`, err)
    this.handlerErrors = this.handlerErrors || new Set()
    if (this.handlerErrors.has(event) || this.handlerErrors.size > 20) return
    this.handlerErrors.add(event)
    this._event(`Skipped a "${event}" packet MineDeck couldn't read (${String(err && err.message).slice(0, 120)})`, 'warn')
  }

  // true once any stage of minecraft-protocol's packet pipeline has been torn down
  _pipelineBroken () {
    const c = this.client
    return !!c && ['serializer', 'deserializer', 'compressor', 'decompressor', 'framer', 'splitter']
      .some(k => c[k] && c[k].destroyed)
  }

  // Answers a server resource pack: accepted + loaded, or declined. Nothing is
  // downloaded either way. During the configuration phase (1.20.2+) mineflayer
  // answers by itself, because the server waits for it before letting you in.
  _answerResourcePack (fields) {
    if (this.ended || !this.client || this.client.state !== 'play') return
    const accept = !!this.settings.acceptResourcePacks
    try {
      for (const result of accept ? [3, 0] : [1]) { // 3 accepted, 0 loaded, 1 declined
        this.client.write('resource_pack_receive', { ...fields, result })
      }
      this._event(accept ? 'Accepted the server\'s resource pack' : 'Declined the server\'s resource pack')
    } catch (e) {
      this._event(`Could not answer the resource pack request: ${e.message}`, 'warn')
    }
  }

  _setState (state) {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }

  _onLoggedIn () {
    this.loggedIn = true
    this.onlineAt = Date.now()
    this._setState('online')
  }

  _onSpawn () {
    this._runJoinCommands()
    this._applyAntiAfk()
    this._interval(() => this._refreshStats(), 2000)
    this._refreshStats()
    this.emit('spawn')
  }

  _runJoinCommands () {
    const cmds = (this.server.joinCommands || []).slice(0, 20)
    const delay = Math.max(0, this.settings.joinCommandDelaySec ?? 2) * 1000
    cmds.forEach((cmd, i) => {
      this._timeout(() => {
        if (this.state !== 'online') return
        try {
          this.send(cmd)
          // only the command's name, never its arguments (they may be a password)
          this._event(`Ran join command: ${cmd.startsWith('/') ? cmd.split(' ')[0] : 'chat message'}`)
        } catch (e) {
          this._event(`Join command failed: ${e.message}`, 'warn')
        }
      }, delay * (i + 1))
    })
  }

  _applyAntiAfk () {
    if (this.afkTimer) { clearInterval(this.afkTimer); this.timers.delete(this.afkTimer); this.afkTimer = null }
    const mode = this.settings.antiAfk
    if (!mode || mode === 'off' || this.state !== 'online') return
    const every = Math.max(5, this.settings.antiAfkIntervalSec || 60) * 1000
    this.afkTimer = this._interval(() => this._antiAfkTick(mode), every)
  }

  _antiAfkTick (mode) {
    if (this.povActive || this.macroActive) return // someone (or a macro) is steering this account
    try {
      if (this.version.engine === 'legacy') {
        if (mode === 'swing') this.client.write('arm_animation', { entityId: this.entityId ?? 0, animation: 1 })
        else if (mode === 'look') this.client.write('look', { yaw: Math.random() * 360, pitch: (Math.random() - 0.5) * 30, onGround: true })
        return
      }
      const bot = this.bot
      if (!bot || !bot.entity) return
      if (mode === 'swing') bot.swingArm('right')
      else if (mode === 'look') bot.look(bot.entity.yaw + (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 0.6, true)
      else if (mode === 'jump') {
        bot.setControlState('jump', true)
        this._timeout(() => { try { bot.setControlState('jump', false) } catch { } }, 350)
      } else if (mode === 'sneak') {
        bot.setControlState('sneak', true)
        this._timeout(() => { try { bot.setControlState('sneak', false) } catch { } }, 800)
      }
    } catch { /* never let anti-AFK crash a session */ }
  }

  _refreshStats () {
    const bot = this.bot
    if (!bot) return
    try {
      const me = bot.player
      this.stats.ping = me && Number.isFinite(me.ping) ? me.ping : this.stats.ping
      if (bot.entity?.position) {
        const p = bot.entity.position
        this.stats.position = { x: p.x, y: p.y, z: p.z }
      }
      this.stats.dimension = bot.game?.dimension ? String(bot.game.dimension).replace('minecraft:', '') : null
      this.stats.gameMode = bot.game?.gameMode || null
      this.stats.health = bot.health ?? this.stats.health
      this.stats.food = bot.food ?? this.stats.food
      const list = Object.values(bot.players || {})
      this.players = list.slice(0, 500).map(p => ({
        name: p.username,
        ping: p.ping,
        display: p.displayName ? toSegments(p.displayName, this.lang) : null
      }))
      this.stats.players = list.length
    } catch { /* stats are best-effort */ }
  }

  applySettings (settings) {
    const afkChanged = settings.antiAfk !== this.settings.antiAfk || settings.antiAfkIntervalSec !== this.settings.antiAfkIntervalSec
    this.settings = settings
    if (this.bot) {
      try { this.bot.options.respawn = !!settings.autoRespawn } catch { }
    }
    if (afkChanged) this._applyAntiAfk()
  }

  /** Sends a chat message or "/command". */
  send (text) {
    if (this.state !== 'online') throw new Error('not connected')
    const msg = String(text).replace(/[\r\n]+/g, ' ').trim()
    if (!msg) return
    if (this.version.engine === 'legacy') {
      this.client.write('chat', { message: msg.slice(0, 100) })
    } else {
      this.bot.chat(msg)
    }
  }

  publicStats () {
    return { ...this.stats, onlineSince: this.onlineAt }
  }

  _fail (err) {
    if (this.ended) return
    this.lastError = err
    try {
      if (this.bot) this.bot.end('error')
      else if (this.client) this.client.end('error')
    } catch { }
    // make sure we end even if the client never emits 'end'
    this._timeout(() => this._onEnd('error'), 1500)
  }

  _onEnd (reason) {
    if (this.ended) return
    this.ended = true
    this._clearTimers()
    const wasOnline = this.loggedIn
    let message
    if (this.kickReason) message = `Kicked: ${this.kickReason}`
    else if (this.manualStop) message = 'Disconnected'
    else if (this.lastError) message = describeError(this.lastError)
    else if (reason && reason !== 'socketClosed') message = `Disconnected (${String(reason).slice(0, 120)})`
    else message = wasOnline ? 'Connection lost' : 'Could not connect'
    this.state = 'offline'
    // late socket errors after a disconnect must never become uncaught exceptions
    try { this.bot?.on('error', () => {}) } catch { }
    try { this.client?.on('error', () => {}) } catch { }
    this.emit('end', {
      message,
      kicked: !!this.kickReason,
      kickReason: this.kickReason,
      wasOnline,
      onlineMs: this.onlineAt ? Date.now() - this.onlineAt : 0,
      manual: !!this.manualStop
    })
  }

  stop () {
    this.manualStop = true
    if (this.ended) return
    try {
      if (this.bot) this.bot.quit()
      else if (this.client) this.client.end('disconnect.quitting')
    } catch { }
    this._timeout(() => this._onEnd('quit'), 3000)
  }
}

module.exports = { Session, describeError, reasonToText }
