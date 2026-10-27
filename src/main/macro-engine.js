'use strict'
// Runs macros: one copy per account, step by step, and starts them by themselves
// when their trigger happens (joining, a chat message, a timer, a menu, death,
// low health). Lives in the main process next to the connections; it only uses
// the manager's public functions and each account's mineflayer bot.
const { EventEmitter } = require('events')
const { matchPattern } = require('./wildcard')
const { StepError, countItems, windowTitle, actions } = require('./macro-actions')

const CHAT_GAP_MS = 300 // at least this long between two chat messages/commands from one account
const MAX_RUNS = 1000
const MAX_DEPTH = 5 // macros running macros running macros...
const RUNAWAY_PER_MINUTE = 20 // a chat-started macro that fires more often than this is switched off
const REASONS = { manual: 'run by you', hotkey: 'hotkey', join: 'joined the server', chat: 'chat message', interval: 'timer', menu: 'menu opened', death: 'died', health: 'low health', restart: 'reconnected' }

class Stopped extends Error {}

function blockMap (steps) {
  const match = new Array(steps.length).fill(-1)
  const elseOf = new Array(steps.length).fill(-1)
  const stack = []
  steps.forEach((s, i) => {
    if (s.type === 'repeat' || s.type === 'if') stack.push(i)
    else if (s.type === 'else' && stack.length) elseOf[stack[stack.length - 1]] = i
    else if (s.type === 'end' && stack.length) {
      const o = stack.pop()
      match[o] = i
      match[i] = o
      if (elseOf[o] >= 0) match[elseOf[o]] = i
    }
  })
  return { match, elseOf }
}

const pad = (n) => String(n).padStart(2, '0')

class MacroEngine extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./manager').Manager} o.manager
   * @param {{ get: (id: string) => ({ name: string } | null) }} o.accounts
   * @param {() => object[]} o.getMacros  the saved macros (already checked by macros.cleanMacro)
   * @param {(id: string, reason: string) => void} [o.onDisable]  switch a macro's automatic start off
   */
  constructor ({ manager, accounts, getMacros, onDisable }) {
    super()
    this.manager = manager
    this.accounts = accounts
    this.getMacros = getMacros
    this.onDisable = onDisable || (() => {})
    this.runs = new Map() // "macroId|accountId" -> run
    this.chatWaiters = new Map() // accountId -> Set
    this.recentChat = new Map() // accountId -> [{ time, text }]
    this.chatFree = new Map() // accountId -> when the next chat message may be sent
    this.lastFired = new Map() // "macroId|accountId" -> time (cooldowns)
    this.fired = new Map() // "macroId|accountId" -> recent trigger times (runaway check)
    this.nextTick = new Map() // "macroId|accountId" -> next interval run
    this.restartOnJoin = new Map() // accountId -> Set of macro ids to start again after a reconnect
    this.staggerAt = new Map() // macroId -> planned start of its latest run
    this.logLines = []
    this.timers = new Set()
    this.listeners = [
      ['line', (line) => this.onLine(line)],
      ['spawn', (id) => this.onSpawn(id)],
      ['window', (id, title) => this.onWindow(id, title)],
      ['death', (id) => this.fire('death', id, {})],
      ['health', (id, health) => this.onHealth(id, health)],
      ['offline', (id) => this.onOffline(id)]
    ]
    for (const [event, fn] of this.listeners) manager.on(event, fn)
    this.interval = setInterval(() => this.tickIntervals(), 1000)
  }

  shutdown () {
    clearInterval(this.interval)
    for (const t of this.timers) clearTimeout(t)
    for (const [event, fn] of this.listeners) this.manager.removeListener(event, fn)
    for (const run of this.runs.values()) this.halt(run, 'MineDeck closed')
  }

  later (fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn() }, ms)
    this.timers.add(t)
  }

  // ------------------------------------------------------------------ lookups
  macros () { return this.getMacros() || [] }
  find (id) { return this.macros().find(m => m.id === id) || null }
  appliesTo (m, id) { return m.accounts === 'all' || m.accounts.includes(id) }
  accountsFor (m) { return m.accounts === 'all' ? [...this.manager.slots.keys()] : m.accounts }
  isOnline (id) {
    const slot = this.manager.slots.get(id)
    return !!slot && slot.status === 'online' && !!slot.session && !slot.session.ended
  }

  accountName (id) { return this.accounts.get(id)?.name || '?' }

  // ------------------------------------------------------------------ running
  /** run a macro on some accounts (or the macro's own accounts); only online accounts start */
  run (macroId, ids = null, reason = 'manual') {
    const m = this.find(macroId)
    if (!m) throw new Error('That macro no longer exists.')
    const targets = (ids && ids.length ? ids : this.accountsFor(m)).filter(id => this.isOnline(id))
    let started = 0
    for (const id of targets) if (this.start(m, id, { reason })) started++
    return { started, online: targets.length }
  }

  start (m, accountId, { reason = 'manual', vars = {} } = {}) {
    const key = `${m.id}|${accountId}`
    if (this.runs.has(key) || this.runs.size >= MAX_RUNS || !this.isOnline(accountId)) return false
    const session = this.manager.slots.get(accountId).session
    // several accounts starting the same macro at once take turns (Options > stagger)
    const now = Date.now()
    const at = Math.max(now, (this.staggerAt.get(m.id) || 0) + m.stagger * 1000)
    this.staggerAt.set(m.id, at)
    const run = {
      key,
      macro: structuredClone(m), // edits apply from the next run
      accountId,
      session,
      vars: { ...vars },
      step: -1,
      status: at > now ? 'starting' : 'running',
      startedAt: now,
      iteration: 1,
      reason,
      stopped: false,
      stopReason: '',
      wakers: new Set(),
      errorsAt: new Map(),
      moved: false
    }
    this.runs.set(key, run)
    session.macroActive = (session.macroActive || 0) + 1
    this.changed()
    this.execute(run, at - now)
    return true
  }

  async execute (run, delay) {
    let end = 'finished'
    let level = 'good'
    try {
      if (delay > 0) await this.sleep(run, delay)
      this.status(run, 'running')
      this.log(run, `started (${REASONS[run.reason] || run.reason})`)
      for (;;) {
        await this.runSteps(run, run.macro.steps, 0)
        if (!run.macro.loop) break
        run.iteration++
        this.status(run, 'waiting to loop')
        await this.sleep(run, Math.max(200, run.macro.loopDelay * 1000))
      }
    } catch (e) {
      if (e instanceof Stopped) { end = e.message; level = 'info' } else { end = `stopped by an error: ${e.message}`; level = 'error' }
    } finally {
      this.runs.delete(run.key)
      run.session.macroActive = Math.max(0, (run.session.macroActive || 1) - 1)
      if (run.moved && run.session.bot && !run.session.ended) {
        try { for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) run.session.bot.setControlState(c, false) } catch { }
      }
      if (end === 'disconnected' && run.macro.onReconnect === 'restart') {
        if (!this.restartOnJoin.has(run.accountId)) this.restartOnJoin.set(run.accountId, new Set())
        this.restartOnJoin.get(run.accountId).add(run.macro.id)
        end = 'disconnected (it starts again when the account reconnects)'
      }
      this.log(run, end, level)
      this.changed()
    }
  }

  async runSteps (run, steps, depth) {
    const { match, elseOf } = blockMap(steps)
    const loops = [] // innermost last: { opener, left, i, at }
    let pc = 0
    let quick = 0
    while (pc < steps.length) {
      this.check(run)
      const s = steps[pc]
      if (depth === 0 && run.step !== pc) { run.step = pc; this.changed() }
      if (s.type === 'repeat') {
        loops.push({ opener: pc, left: s.times === 0 ? Infinity : s.times, i: 1, at: Date.now() })
        run.vars.i = '1'
        pc++
        continue
      }
      if (s.type === 'end') {
        const opener = match[pc]
        const loop = loops[loops.length - 1]
        if (opener >= 0 && steps[opener].type === 'repeat' && loop && loop.opener === opener) {
          if (--loop.left > 0) {
            // every pass through a loop takes at least 50 ms, so a loop without waits can't hog MineDeck
            const spent = Date.now() - loop.at
            if (spent < 50) await this.sleep(run, 50 - spent)
            loop.i++
            loop.at = Date.now()
            run.vars.i = String(loop.i)
            pc = opener + 1
            continue
          }
          loops.pop()
          if (loops.length) run.vars.i = String(loops[loops.length - 1].i)
        }
        pc++
        continue
      }
      if (s.type === 'if') {
        pc = this.condition(run, s) ? pc + 1 : (elseOf[pc] >= 0 ? elseOf[pc] + 1 : match[pc] + 1)
        continue
      }
      if (s.type === 'else') { pc = match[pc] + 1; continue }
      const t0 = Date.now()
      await this.exec(run, s, pc, depth)
      if (Date.now() - t0 < 5) {
        if (++quick >= 25) { quick = 0; await this.sleep(run, 25) }
      } else quick = 0
      pc++
    }
  }

  async exec (run, s, pc, depth) {
    const session = run.session
    const bot = session.bot
    const needBot = () => {
      if (!bot || !bot.entity) throw new StepError('this step needs Minecraft 1.8 or newer')
    }
    const ctx = { sleep: (ms) => this.sleep(run, ms), fill: (t) => this.fill(run, t), lang: session.lang }
    try {
      switch (s.type) {
        case 'chat': return await this.say(run, ctx.fill(s.text))
        case 'wait': {
          const sec = s.max !== null && s.max > s.sec ? s.sec + Math.random() * (s.max - s.sec) : s.sec
          this.status(run, `waiting ${sec < 60 ? `${Math.round(sec * 10) / 10}s` : `${Math.round(sec / 6) / 10} min`}`)
          return await ctx.sleep(sec * 1000)
        }
        case 'waitChat': {
          const pattern = ctx.fill(s.match)
          this.status(run, `waiting for chat "${pattern.slice(0, 40)}"`)
          const found = await this.waitChat(run, pattern, s.timeout * 1000)
          if (found) return this.capture(run, found.result, found.text)
          if (s.onTimeout === 'stop') throw new Stopped(`stopped: "${pattern}" didn't show up in chat`)
          throw new StepError(`"${pattern}" didn't show up in chat within ${s.timeout}s`)
        }
        case 'waitMenu': {
          needBot()
          this.status(run, 'waiting for a menu')
          if (await actions.waitMenu(bot, s, ctx)) return
          if (s.onTimeout === 'stop') throw new Stopped('stopped: no menu opened')
          throw new StepError('no menu opened in time')
        }
        case 'click': {
          needBot()
          this.status(run, 'clicking in a menu')
          try {
            return await actions.clickMenu(bot, s, ctx)
          } catch (e) {
            if (e instanceof StepError && s.onFail === 'stop') throw new Stopped(`stopped: ${e.message}`)
            throw e
          }
        }
        case 'closeMenu': needBot(); if (bot.currentWindow) bot.closeWindow(bot.currentWindow); return
        case 'use': needBot(); return await actions.use(bot, s, ctx)
        case 'attack': needBot(); return await actions.attack(bot, s, ctx)
        case 'hotbar': needBot(); bot.setQuickBarSlot(s.slot - 1); return
        case 'equip': needBot(); return await actions.equip(bot, s.item, ctx)
        case 'eat': needBot(); this.status(run, 'eating'); return await actions.eat(bot, s)
        case 'drop': needBot(); return await actions.drop(bot, s, ctx)
        case 'fish': needBot(); this.status(run, 'fishing'); return await actions.fish(bot, s, ctx)
        case 'look': needBot(); return await actions.look(bot, s, ctx)
        case 'move': needBot(); run.moved = true; this.status(run, `walking ${s.dir}`); return await actions.move(bot, s, ctx)
        case 'goto': needBot(); run.moved = true; this.status(run, `walking to ${s.x} ${s.z}`); return await actions.goto(bot, s, ctx)
        case 'control': needBot(); run.moved = true; return await actions.control(bot, s, ctx)
        case 'respawn': needBot(); if (bot.isAlive === false) bot.respawn(); return
        case 'set': run.vars[s.name] = ctx.fill(s.value); return
        case 'run': {
          const sub = this.find(s.macro)
          if (!sub) throw new StepError('the macro it runs was deleted')
          if (depth >= MAX_DEPTH) throw new StepError('too many macros inside macros')
          return await this.runSteps(run, sub.steps, depth + 1)
        }
        case 'log': {
          const text = ctx.fill(s.text)
          this.log(run, text, s.notify ? 'notify' : 'info')
          if (s.notify) this.emit('notify', { acc: run.accountId, name: this.accountName(run.accountId), macro: run.macro.name, text })
          return
        }
        case 'stop': throw new Stopped('stopped by a Stop step')
        case 'disconnect':
          this.log(run, 'disconnecting the account', 'warn')
          this.manager.disconnect([run.accountId])
          throw new Stopped('disconnected the account')
      }
    } catch (e) {
      if (e instanceof Stopped) throw e
      this.check(run) // stopped or disconnected while the step ran
      this.stepError(run, pc, e)
    }
  }

  // a step that went wrong: say so (at most every 30 s per step), carry on
  stepError (run, pc, e) {
    const now = Date.now()
    if (now - (run.errorsAt.get(pc) || 0) < 30000) return
    run.errorsAt.set(pc, now)
    this.log(run, `step ${pc + 1}: ${e instanceof StepError ? e.message : `failed (${e.message})`}`, 'warn')
  }

  condition (run, s) {
    const session = run.session
    const bot = session.bot && session.bot.entity ? session.bot : null
    let ok = false
    switch (s.cond) {
      case 'health': ok = Number(bot ? bot.health : session.stats.health) < s.value; break
      case 'food': ok = Number(bot ? bot.food : session.stats.food) < s.value; break
      case 'item': ok = !!bot && countItems(bot, this.fill(run, s.item), session.lang) >= s.count; break
      case 'menu': ok = !!bot && !!bot.currentWindow && (!s.match.trim() || !!matchPattern(this.fill(run, s.match), windowTitle(bot.currentWindow, session.lang))); break
      case 'chat': {
        const since = Date.now() - s.within * 1000
        const pattern = this.fill(run, s.match)
        ok = (this.recentChat.get(run.accountId) || []).some(l => l.time >= since && matchPattern(pattern, l.text))
        break
      }
      case 'chance': ok = Math.random() * 100 < s.value; break
      case 'text': {
        const a = this.fill(run, s.left).trim().toLowerCase()
        const b = this.fill(run, s.right).trim().toLowerCase()
        ok = s.op === 'contains' ? a.includes(b) : a === b
        break
      }
    }
    return s.not ? !ok : ok
  }

  // ------------------------------------------------------------------ chat
  async say (run, text) {
    if (!text.trim()) return
    // reserve this account's next free moment, so messages never go out faster than CHAT_GAP_MS
    const now = Date.now()
    const at = Math.max(now, this.chatFree.get(run.accountId) || 0)
    this.chatFree.set(run.accountId, at + CHAT_GAP_MS)
    if (at > now) await this.sleep(run, at - now)
    if (!this.manager.sendFrom(run.accountId, text)) throw new StepError('could not send: the account is offline')
  }

  waitChat (run, pattern, ms) {
    return new Promise((resolve, reject) => {
      if (!this.chatWaiters.has(run.accountId)) this.chatWaiters.set(run.accountId, new Set())
      const set = this.chatWaiters.get(run.accountId)
      const done = () => { clearTimeout(timer); set.delete(waiter); run.wakers.delete(onStop) }
      const waiter = {
        test: (text) => {
          const result = matchPattern(pattern, text)
          if (result) { done(); resolve({ result, text }) }
        }
      }
      const onStop = () => { done(); reject(new Stopped(run.stopReason)) }
      const timer = setTimeout(() => { done(); resolve(null) }, ms)
      set.add(waiter)
      run.wakers.add(onStop)
    })
  }

  capture (run, result, text) {
    run.vars.match = result.match
    run.vars.message = text
    result.groups.slice(0, 9).forEach((g, i) => { run.vars[String(i + 1)] = g.trim() })
  }

  // ------------------------------------------------------------------ triggers
  onLine (line) {
    if (line.kind !== 'chat' || !line.acc) return
    const recent = this.recentChat.get(line.acc) || []
    recent.push({ time: line.time || Date.now(), text: line.text })
    if (recent.length > 60) recent.splice(0, recent.length - 60)
    this.recentChat.set(line.acc, recent)
    for (const w of [...(this.chatWaiters.get(line.acc) || [])]) w.test(line.text)
    this.fire('chat', line.acc, { message: line.text }, (m) => {
      const result = matchPattern(this.fillFor(line.acc, m.trigger.match), line.text)
      if (!result) return null
      const vars = { match: result.match, message: line.text }
      result.groups.slice(0, 9).forEach((g, i) => { vars[String(i + 1)] = g.trim() })
      return vars
    })
  }

  onSpawn (id) {
    const again = this.restartOnJoin.get(id)
    if (again) {
      this.restartOnJoin.delete(id)
      this.later(() => {
        for (const macroId of again) {
          const m = this.find(macroId)
          if (m) this.start(m, id, { reason: 'restart' })
        }
      }, 3000)
    }
    for (const m of this.macros()) {
      if (!m.enabled || m.trigger.type !== 'join' || !this.appliesTo(m, id)) continue
      this.later(() => {
        const now = this.find(m.id)
        if (now && now.enabled && now.trigger.type === 'join') this.fire('join', id, {}, (x) => (x.id === m.id ? {} : null))
      }, m.trigger.delay * 1000)
    }
  }

  onWindow (id, title) {
    this.fire('menu', id, { title }, (m) => (matchPattern(this.fillFor(id, m.trigger.match), title) ? { title } : null))
  }

  onHealth (id, health) {
    this.fire('health', id, { health: String(Math.round(health * 10) / 10) }, (m) => (health < m.trigger.below ? {} : null))
  }

  onOffline (id) {
    for (const run of this.runs.values()) if (run.accountId === id) this.halt(run, 'disconnected')
    for (const key of this.nextTick.keys()) if (key.endsWith(`|${id}`)) this.nextTick.delete(key)
    this.chatWaiters.delete(id)
  }

  /** start the macros whose trigger is `type` for this account (filter may add variables or veto) */
  fire (type, id, vars, filter) {
    const now = Date.now()
    for (const m of this.macros()) {
      if (!m.enabled || m.trigger.type !== type || !this.appliesTo(m, id)) continue
      const key = `${m.id}|${id}`
      if (this.runs.has(key)) continue
      if (now - (this.lastFired.get(key) || 0) < m.trigger.cooldown * 1000) continue
      const extra = filter ? filter(m) : {}
      if (!extra) continue
      // a macro that keeps starting itself (it says what it reacts to...) is switched off
      const times = (this.fired.get(key) || []).filter(t => now - t < 60000)
      times.push(now)
      this.fired.set(key, times)
      if (times.length > RUNAWAY_PER_MINUTE) {
        this.fired.delete(key)
        this.onDisable(m.id, `it started more than ${RUNAWAY_PER_MINUTE} times in a minute`)
        continue
      }
      this.lastFired.set(key, now)
      this.start(m, id, { reason: type, vars: { ...vars, ...extra } })
    }
  }

  tickIntervals () {
    const now = Date.now()
    for (const m of this.macros()) {
      if (!m.enabled || m.trigger.type !== 'interval') continue
      const period = m.trigger.every * 60000
      for (const id of this.accountsFor(m)) {
        const key = `${m.id}|${id}`
        if (!this.isOnline(id)) { this.nextTick.delete(key); continue }
        const next = this.nextTick.get(key)
        // first run shortly after the account is online (or the timer is switched on)
        if (next === undefined) { this.nextTick.set(key, now + Math.min(10000, period)); continue }
        if (now < next) continue
        const jitter = 1 + (Math.random() * 2 - 1) * (m.trigger.jitter / 100)
        this.nextTick.set(key, now + Math.max(3000, period * jitter))
        if (!this.runs.has(key)) this.start(m, id, { reason: 'interval' })
      }
    }
  }

  // ------------------------------------------------------------------ stopping
  /** stop runs: of one macro, on one account, both, or everything */
  stop ({ macroId = null, accountId = null } = {}) {
    let n = 0
    for (const run of this.runs.values()) {
      if ((macroId && run.macro.id !== macroId) || (accountId && run.accountId !== accountId)) continue
      this.halt(run, 'stopped')
      n++
    }
    for (const [acc, set] of this.restartOnJoin) {
      if (accountId && acc !== accountId) continue
      if (macroId) set.delete(macroId)
      else set.clear()
    }
    return n
  }

  halt (run, reason) {
    if (run.stopped) return
    run.stopped = true
    run.stopReason = reason
    for (const wake of [...run.wakers]) wake()
  }

  check (run) {
    if (!run.stopped && (run.session.ended || this.manager.slots.get(run.accountId)?.session !== run.session)) {
      run.stopped = true
      run.stopReason = 'disconnected'
    }
    if (run.stopped) throw new Stopped(run.stopReason)
  }

  sleep (run, ms) {
    this.check(run)
    return new Promise((resolve, reject) => {
      const onStop = () => { clearTimeout(timer); run.wakers.delete(onStop); reject(new Stopped(run.stopReason)) }
      const timer = setTimeout(() => { run.wakers.delete(onStop); resolve() }, Math.max(0, ms))
      run.wakers.add(onStop)
    })
  }

  // ------------------------------------------------------------------ text with {variables}
  fill (run, text) {
    return this.fillText(String(text ?? ''), run.accountId, run.vars)
  }

  fillFor (accountId, text) {
    return this.fillText(String(text ?? ''), accountId, {})
  }

  fillText (text, accountId, vars) {
    if (!text.includes('{')) return text
    const slot = this.manager.slots.get(accountId)
    const session = slot?.session
    const bot = session?.bot?.entity ? session.bot : null
    const now = new Date()
    return text.replace(/\{([a-z0-9_]+)(?::(-?\d+)-(-?\d+))?\}/gi, (all, name, a, b) => {
      const key = name.toLowerCase()
      if (Object.hasOwn(vars, name)) return vars[name]
      if (Object.hasOwn(vars, key)) return vars[key]
      switch (key) {
        case 'account': return this.accountName(accountId)
        case 'server': return slot?.server?.host || ''
        case 'x': return bot ? String(Math.floor(bot.entity.position.x)) : ''
        case 'y': return bot ? String(Math.floor(bot.entity.position.y)) : ''
        case 'z': return bot ? String(Math.floor(bot.entity.position.z)) : ''
        case 'health': return String(Math.round(Number(bot ? bot.health : session?.stats.health) || 0))
        case 'food': return String(Math.round(Number(bot ? bot.food : session?.stats.food) || 0))
        case 'time': return `${pad(now.getHours())}:${pad(now.getMinutes())}`
        case 'date': return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        case 'random': {
          if (a === undefined) return String(Math.floor(Math.random() * 100) + 1)
          const lo = Math.min(Number(a), Number(b))
          const hi = Math.max(Number(a), Number(b))
          return String(lo + Math.floor(Math.random() * (hi - lo + 1)))
        }
        default: return all
      }
    })
  }

  // ------------------------------------------------------------------ reporting
  status (run, text) {
    if (run.status === text) return
    run.status = text
    this.changed()
  }

  log (run, text, level = 'info') {
    const entry = { time: Date.now(), acc: run.accountId, name: this.accountName(run.accountId), macroId: run.macro.id, macro: run.macro.name, text: String(text).slice(0, 300), level }
    this.logLines.push(entry)
    if (this.logLines.length > 300) this.logLines.splice(0, this.logLines.length - 300)
    this.emit('log', entry)
  }

  publicRuns () {
    return [...this.runs.values()].map(r => ({ key: r.key, macroId: r.macro.id, accountId: r.accountId, step: r.step, status: r.status, startedAt: r.startedAt, iteration: r.iteration }))
  }

  changed () {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.emit('runs', this.publicRuns())
    }, 200)
  }
}

module.exports = { MacroEngine, blockMap }
