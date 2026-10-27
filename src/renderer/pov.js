// POV tab: see through one account's eyes and steer it. Look around with the
// mouse, walk with WASD, hit and use things, pick hotbar slots, click items in
// server menus ("click to confirm" screens), and chat as that account.
import { h, clear, store } from './ui.js'
import { icon } from './icons.js'
import { renderSegments } from './chat.js'
import { Renderer, direction, skyFor } from './pov-gl.js'

const api = window.minedeck
const CONTROL_KEYS = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump', ShiftLeft: 'sneak', ShiftRight: 'sneak', ControlLeft: 'sprint', ControlRight: 'sprint' }
const FACING = ['north', 'west', 'south', 'east'] // mineflayer yaw 0, 90°, 180°, 270° (counter-clockwise)
const FAR = 72 // blocks
const plain = (seg) => (seg || []).map(s => s.t).join('')
const rgb = (c) => (c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : 'transparent')
const angleDiff = (a, b) => ((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
// same list as src/main/secrets.js: never kept in the chat box's history
const SECRET_COMMAND = /^(\/(?:login|log|l|register|reg|changepassword|changepass|cp|unregister|unreg|2fa|totp))(\s+)\S.*$/i

export class PovView {
  /**
   * @param {HTMLElement} root  the panel to fill
   * @param {object} o
   * @param {() => Array<{id:string,name:string}>} o.accounts
   * @param {(id:string) => string} o.status  account status ('online', ...)
   * @param {() => boolean} o.modalOpen
   * @param {() => object[]} o.history  chat lines already received (all accounts)
   * @param {Function} o.chatClick  what clicking a "[Click here]" in chat does
   */
  constructor (root, { accounts, status, modalOpen, history, chatClick }) {
    this.chatClick = chatClick
    this.root = root
    this.accounts = accounts
    this.statusOf = status
    this.modalOpen = modalOpen
    this.history = history
    this.id = store('povAccount')
    this.active = false
    this.sensitivity = Number(store('povSensitivity')) || 1
    this.reset()
    this.build()
    this.onFrame = this.onFrame.bind(this)
    document.addEventListener('pointerlockchange', () => this.onLockChange())
    document.addEventListener('pointerlockerror', () => this.lockRefused())
    document.addEventListener('keydown', (e) => this.onKey(e, true))
    document.addEventListener('keyup', (e) => this.onKey(e, false))
    document.addEventListener('mousemove', (e) => this.onMouseMove(e))
    document.addEventListener('mouseup', (e) => this.onMouseUp(e))
    window.addEventListener('blur', () => this.releaseControls())
  }

  reset () {
    this.self = null
    this.prev = null
    this.selfAt = 0
    this.entities = new Map()
    this.window = null
    this.hotbar = []
    this.selected = 0
    this.loaded = false
    this.sentYaw = null
    this.lookAt = 0
  }

  name () {
    return this.accounts().find(a => a.id === this.id)?.name || 'this account'
  }

  // ------------------------------------------------------------------ DOM
  build () {
    const stage = h('div', { class: 'pov-stage', tabindex: '0' })
    this.canvas = h('canvas', { class: 'pov-canvas' })
    this.tagsEl = h('div', { class: 'pov-tags' })
    this.infoEl = h('div', { class: 'pov-info' })
    this.titleEl = h('div', { class: 'pov-title', hidden: true }, h('div', { class: 't' }), h('div', { class: 'st' }))
    this.actionEl = h('div', { class: 'pov-actionbar', hidden: true })
    this.heldEl = h('div', { class: 'pov-held', hidden: true })
    this.healthEl = h('div', { class: 'pov-bar health', title: 'Health' }, icon('heart', 13), h('div', { class: 'track' }, h('i')), h('span'))
    this.foodEl = h('div', { class: 'pov-bar food', title: 'Hunger' }, icon('food', 13), h('div', { class: 'track' }, h('i')), h('span'))
    this.levelEl = h('div', { class: 'pov-level', title: 'Experience level' })
    this.hotbarEl = h('div', { class: 'pov-hotbar' })
    this.chatLinesEl = h('div', { class: 'pov-chat-lines' })
    this.chatInput = h('input', { class: 'pov-chat-input', placeholder: 'Press T to chat', maxlength: 256, autocomplete: 'off', spellcheck: 'false' })
    this.chatEl = h('div', { class: 'pov-chat' }, this.chatLinesEl,
      h('form', { class: 'pov-chat-form', onsubmit: (e) => { e.preventDefault(); this.sendChat() } }, this.chatInput))
    this.hintEl = h('div', { class: 'pov-hint' })
    this.menuEl = h('div', { class: 'pov-menu', hidden: true })
    this.cursorEl = h('div', { class: 'pov-cursor', hidden: true })
    this.tipEl = h('div', { class: 'pov-tip', hidden: true })
    this.statusEl = h('div', { class: 'pov-status', hidden: true })
    this.deathEl = h('div', { class: 'pov-death', hidden: true },
      h('div', { class: 'pov-death-title', text: 'You died!' }),
      h('button', { class: 'btn primary', onclick: () => api.call('pov', 'respawn').catch(() => {}) }, 'Respawn'))
    this.noticeEl = h('div', { class: 'pov-notice', hidden: true })
    stage.append(this.canvas, this.tagsEl, h('div', { class: 'pov-cross' }), this.infoEl, this.titleEl,
      h('div', { class: 'pov-hud' }, this.actionEl, this.heldEl, h('div', { class: 'pov-stats' }, this.healthEl, this.levelEl, this.foodEl), this.hotbarEl),
      this.chatEl, this.hintEl, this.deathEl, this.menuEl, this.cursorEl, this.tipEl, this.statusEl, this.noticeEl)
    this.stage = stage
    clear(this.root).appendChild(stage)

    stage.addEventListener('mousedown', (e) => this.onMouseDown(e))
    stage.addEventListener('contextmenu', (e) => e.preventDefault())
    stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.chatInput.addEventListener('focus', () => { this.chatEl.classList.add('open'); this.chatInput.placeholder = 'Message or /command · Enter to send · Esc to go back'; this.releaseControls(); this.renderChat() })
    this.chatInput.addEventListener('blur', () => { this.chatEl.classList.remove('open'); this.chatInput.placeholder = 'Press T to chat'; this.renderChat() })
    this.sentHistory = []
    this.historyAt = -1
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.chatInput.value = ''; this.chatInput.blur(); this.stage.focus() }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const list = this.sentHistory
        if (!list.length) return
        e.preventDefault()
        this.historyAt = e.key === 'ArrowUp' ? Math.min(list.length - 1, this.historyAt + 1) : Math.max(-1, this.historyAt - 1)
        this.chatInput.value = this.historyAt < 0 ? '' : list[list.length - 1 - this.historyAt]
      }
    })
    this.menuEl.addEventListener('mousemove', (e) => this.moveCursor(e))
    // clicking "[Click here]" text in chat must not take the focus from the chat box (that would close it first)
    this.chatLinesEl.addEventListener('mousedown', (e) => e.preventDefault())

    try {
      this.renderer = new Renderer(this.canvas)
    } catch (e) {
      console.error('[pov] WebGL setup failed', e)
      this.renderer = null
    }
    if (!this.renderer || !this.renderer.ok) {
      this.noticeEl.hidden = false
      this.noticeEl.textContent = 'The 3D view needs WebGL 2, which this PC\'s graphics driver doesn\'t offer. Menus, the hotbar, chat and movement still work.'
    }
    this.chat = []
    this.renderHint()
    this.renderHotbar()

    // toolbar: which account, inventory, mouse speed
    this.picker = h('select', { class: 'input slim', id: 'pov-account', 'aria-label': 'Account to view', onchange: (e) => { this.open(e.target.value); e.target.blur() } })
    const speed = h('input', { type: 'range', min: '0.3', max: '3', step: '0.1', value: String(this.sensitivity), class: 'pov-speed', 'aria-label': 'Mouse speed', oninput: (e) => { this.sensitivity = Number(e.target.value); store('povSensitivity', this.sensitivity) } })
    this.tools = h('div', { class: 'pov-tools', id: 'pov-tools', hidden: true },
      h('label', { class: 'view-pick' }, h('span', { class: 'muted', text: 'Viewing' }), this.picker),
      h('button', { class: 'btn small ghost', id: 'pov-inventory', title: 'Inventory (E)', onclick: () => this.toggleInventory() }, icon('box', 13), 'Inventory'),
      h('label', { class: 'view-pick', title: 'Mouse speed' }, icon('mouse', 14), speed))
  }

  renderPicker () {
    const sel = this.picker
    clear(sel)
    const list = this.accounts()
    const usable = list.filter(a => this.statusOf(a.id) === 'online' || a.id === this.id)
    if (!usable.length) sel.appendChild(h('option', { value: '', text: 'No account online' }))
    for (const a of usable) sel.appendChild(h('option', { value: a.id, text: this.statusOf(a.id) === 'online' ? a.name : `${a.name} (offline)` }))
    sel.value = this.id && usable.some(a => a.id === this.id) ? this.id : ''
    sel.disabled = !usable.length
  }

  // ------------------------------------------------------------------ open / close
  /** the POV tab became visible */
  show (id) {
    this.active = true
    this.tools.hidden = false
    const online = this.accounts().filter(a => this.statusOf(a.id) === 'online')
    const pick = id || (this.id && this.accounts().some(a => a.id === this.id) ? this.id : null) || online[0]?.id || null
    this.open(pick)
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(this.onFrame)
  }

  /** the POV tab was left */
  hide () {
    if (!this.active) return
    this.active = false
    this.tools.hidden = true
    cancelAnimationFrame(this.raf)
    this.releaseControls()
    if (document.pointerLockElement) document.exitPointerLock()
    api.call('povClose').catch(() => {})
  }

  async open (id) {
    this.releaseControls()
    if (this.renderer) this.renderer.reset(0, 256)
    this.reset()
    this.renderMenu(null)
    this.renderHotbar()
    if (id !== this.id || !this.chat.length) {
      this.chat = []
      if (id) this.onLines(this.history().slice(-400), id)
    }
    this.id = id || null
    if (id) store('povAccount', id)
    this.renderPicker()
    this.renderChat()
    this.renderHint()
    if (!id) return this.setStatus('pick')
    this.setStatus('loading')
    try {
      const r = await api.call('povOpen', id)
      if (this.id !== id) return
      if (!r.ok) this.setStatus('error', r.reason)
      else if (r.waiting) this.setStatus('waiting')
    } catch (e) {
      this.setStatus('error', e.message)
    }
  }

  setStatus (kind, message) {
    this.statusKind = kind
    const el = this.statusEl
    clear(el)
    if (!kind) { el.hidden = true; return }
    el.hidden = false
    const name = this.name()
    const card = h('div', { class: 'pov-status-card' })
    if (kind === 'pick') {
      const online = this.accounts().filter(a => this.statusOf(a.id) === 'online')
      card.append(icon('eye', 26), h('b', { text: 'See through an account\'s eyes' }),
        h('p', { class: 'muted', text: online.length ? 'Pick an online account to look around, walk, click menus and chat as it.' : 'Connect an account first. Its view appears here once it\'s online.' }))
      if (online.length) card.appendChild(h('div', { class: 'pov-pick' }, online.slice(0, 8).map(a => h('button', { class: 'btn small', onclick: () => this.open(a.id) }, a.name))))
    } else if (kind === 'loading') {
      card.append(h('div', { class: 'spinner' }), h('b', { text: `Loading the world around ${name}…` }))
    } else if (kind === 'waiting') {
      card.append(icon('refresh', 24), h('b', { text: `${name} isn't online right now` }), h('p', { class: 'muted', text: 'The view starts by itself as soon as it joins the server.' }))
    } else if (kind === 'ended') {
      card.append(icon('alert', 24), h('b', { text: `${name} was disconnected` }), h('p', { class: 'muted', text: 'If auto-reconnect is on, the view comes back when it rejoins.' }))
    } else {
      card.append(icon('alert', 24), h('b', { text: 'POV isn\'t available' }), h('p', { class: 'muted', text: message || 'Something went wrong.' }))
    }
    el.appendChild(card)
  }

  // ------------------------------------------------------------------ events from the main process
  onPov ({ id, kind, data }) {
    if (id !== this.id || !this.active) return
    switch (kind) {
      case 'init':
      case 'reset':
        if (this.renderer) this.renderer.reset(data.minY, data.height)
        this.dimension = data.dimension
        this.entities.clear()
        if (kind === 'init') { this.self = null; this.setStatus('loading') }
        break
      case 'sections':
        if (!this.renderer) break
        this.renderer.world.setPalette(data.palette)
        for (const s of data.sections) this.renderer.world.put(s)
        break
      case 'drop':
        if (this.renderer) this.renderer.drop(data)
        break
      case 'self': this.onSelf(data); break
      case 'entities': this.onEntities(data); break
      case 'inventory':
        this.hotbar = data.hotbar
        if (data.selected !== this.selected) this.showHeld(data.hotbar[data.selected])
        this.selected = data.selected
        this.renderHotbar()
        break
      case 'window': this.renderMenu(data); break
      case 'actionbar': this.flash(this.actionEl, data, 2500); break
      case 'title':
        if (!data) { this.titleEl.hidden = true; break }
        clear(this.titleEl.querySelector(data.type === 'subtitle' ? '.st' : '.t')).appendChild(renderSegments(data.text, ''))
        if (data.type !== 'subtitle') clear(this.titleEl.querySelector('.st'))
        this.flash(this.titleEl, null, 3500)
        break
      case 'end':
        if (data.reason === 'disconnected') { this.releaseControls(); this.renderMenu(null); this.setStatus('ended') }
        break
      case 'waiting': this.setStatus('waiting'); break
      case 'unsupported': this.setStatus('error', data); break
    }
  }

  onSelf (s) {
    const now = performance.now()
    const first = !this.self
    this.prev = this.self ? this.eyeBase(now) : s
    this.self = s
    this.selfAt = now
    if (first) this.renderHint()
    if (this.sentYaw === null) {
      this.yaw = s.yaw
      this.pitch = s.pitch
      this.sentYaw = s.yaw
      this.sentPitch = s.pitch
    } else if (now - this.lookAt > 400 && (Math.abs(angleDiff(s.yaw, this.sentYaw)) > 0.02 || Math.abs(s.pitch - this.sentPitch) > 0.02)) {
      // the server turned us (teleport, respawn...)
      this.yaw = s.yaw
      this.pitch = s.pitch
      this.sentYaw = s.yaw
      this.sentPitch = s.pitch
    }
    if (this.statusKind) this.setStatus(null)
    this.renderStats()
    const dead = s.alive === false
    if (dead !== !this.deathEl.hidden) {
      this.deathEl.hidden = !dead
      if (dead) { this.releaseControls(); if (document.pointerLockElement) document.exitPointerLock() }
    }
  }

  /** the account list changed: stop showing an account that was removed */
  onAccounts () {
    if (this.id && !this.accounts().some(a => a.id === this.id)) this.open(null)
    else this.renderPicker()
  }

  // camera position between the last two updates (they arrive 20 times a second)
  eyeBase (now) {
    const s = this.self
    const p = this.prev || s
    const f = Math.min(1, (now - this.selfAt) / 50)
    return { x: p.x + (s.x - p.x) * f, y: p.y + (s.y - p.y) * f, z: p.z + (s.z - p.z) * f }
  }

  onEntities (list) {
    const now = performance.now()
    const seen = new Set()
    for (const e of list) {
      seen.add(e.id)
      const old = this.entities.get(e.id)
      if (old) {
        const f = Math.min(1, (now - old.t) / 100)
        old.px = old.px + (old.tx - old.px) * f
        old.py = old.py + (old.ty - old.py) * f
        old.pz = old.pz + (old.tz - old.pz) * f
        if (Math.hypot(e.x - old.px, e.y - old.py, e.z - old.pz) > 8) { old.px = e.x; old.py = e.y; old.pz = e.z } // teleported
        Object.assign(old, e, { tx: e.x, ty: e.y, tz: e.z, t: now })
      } else {
        this.entities.set(e.id, { ...e, px: e.x, py: e.y, pz: e.z, tx: e.x, ty: e.y, tz: e.z, t: now })
      }
    }
    for (const id of this.entities.keys()) if (!seen.has(id)) this.entities.delete(id)
  }

  /** chat lines from the main window's stream */
  onLines (lines, id = this.id) {
    let added = false
    for (const l of lines) {
      if (l.acc !== id || !(l.kind === 'chat' || l.kind === 'sent' || (l.kind === 'event' && l.level !== 'info'))) continue
      this.chat.push({ seg: l.seg, text: l.text, kind: l.kind, level: l.level, time: id === this.id ? Date.now() : l.time })
      added = true
    }
    if (this.chat.length > 80) this.chat.splice(0, this.chat.length - 80)
    if (added) this.renderChat()
  }

  // ------------------------------------------------------------------ drawing
  onFrame (now) {
    if (!this.active) return
    this.raf = requestAnimationFrame(this.onFrame)
    const r = this.renderer
    if (!this.self) {
      if (r && r.ok) r.draw({ eye: [0, 0, 0], yaw: 0, pitch: 0, sky: [0.08, 0.09, 0.11], light: 1, far: FAR, entities: [], target: null })
      return
    }
    const base = this.eyeBase(now)
    const eye = [base.x, base.y + (this.self.sneaking ? 1.27 : 1.62), base.z]
    const ents = []
    for (const e of this.entities.values()) {
      const f = Math.min(1, (now - e.t) / 100)
      ents.push({ ...e, x: e.px + (e.tx - e.px) * f, y: e.py + (e.ty - e.py) * f, z: e.pz + (e.tz - e.pz) * f })
    }
    let target = null
    if (r && r.ok) {
      r.remesh(eye, 7)
      target = r.world.raycast(eye[0], eye[1], eye[2], direction(this.yaw, this.pitch), 5)
      const { sky, light } = skyFor(this.self.dimension || this.dimension || '', this.self.time)
      this.view = { eye, yaw: this.yaw, pitch: this.pitch, sky, light, far: FAR, entities: ents, target }
      r.draw(this.view)
      this.renderTags(ents)
    }
    if (now - (this.infoAt || 0) > 150) {
      this.infoAt = now
      this.renderInfo(base, target)
    }
  }

  renderTags (ents) {
    const view = this.view
    const shown = new Set()
    const list = ents.filter(e => e.tag || (e.kind === 'player' && !e.invisible)).sort((a, b) => a.d - b.d).slice(0, 40)
    this.tagEls = this.tagEls || new Map()
    for (const e of list) {
      const p = this.renderer.project(view, e.x, e.y + e.h + 0.3, e.z)
      if (!p || p.dist > (e.kind === 'player' ? 48 : 24)) continue
      shown.add(e.id)
      let el = this.tagEls.get(e.id)
      const key = e.tag ? JSON.stringify(e.tag) : e.name
      if (!el) {
        el = h('div', { class: 'pov-tag' })
        this.tagsEl.appendChild(el)
        this.tagEls.set(e.id, el)
      }
      if (el.dataset.key !== key) {
        el.dataset.key = key
        clear(el).appendChild(e.tag ? renderSegments(e.tag, e.name) : document.createTextNode(e.name))
      }
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${Math.max(0.55, Math.min(1, 10 / p.dist)).toFixed(2)}) translate(-50%, -100%)`
    }
    for (const [id, el] of this.tagEls) {
      if (!shown.has(id)) { el.remove(); this.tagEls.delete(id) }
    }
  }

  renderInfo (pos, target) {
    const s = this.self
    const deg = ((this.yaw * 180 / Math.PI) % 360 + 360) % 360
    const facing = FACING[Math.round(deg / 90) % 4]
    const lines = [
      `X ${pos.x.toFixed(1)}  Y ${pos.y.toFixed(1)}  Z ${pos.z.toFixed(1)}`,
      `facing ${facing} · ${(s.dimension || 'overworld').replace(/_/g, ' ')}${s.gameMode ? ` · ${s.gameMode}` : ''}`
    ]
    if (target) lines.push(`looking at ${target.name.replace(/_/g, ' ')}`)
    const text = lines.join('\n')
    if (this.infoEl.textContent !== text) this.infoEl.textContent = text
  }

  renderStats () {
    const s = this.self
    const key = `${s.health}|${s.food}|${s.level}|${s.gameMode}`
    if (key === this.statsKey) return
    this.statsKey = key
    const set = (el, v, max) => {
      const n = Number.isFinite(v) ? v : 0
      el.querySelector('i').style.width = `${Math.max(0, Math.min(100, n / max * 100))}%`
      el.querySelector('span').textContent = Number.isFinite(v) ? `${Math.round(n * 10) / 10}` : '?'
    }
    set(this.healthEl, s.health, 20)
    set(this.foodEl, s.food, 20)
    this.levelEl.textContent = s.level ? String(s.level) : ''
    this.levelEl.hidden = !s.level
    const creative = /creative|spectator/.test(String(s.gameMode))
    this.healthEl.hidden = creative
    this.foodEl.hidden = creative
  }

  renderHotbar () {
    clear(this.hotbarEl)
    for (let i = 0; i < 9; i++) {
      const it = this.hotbar[i]
      const el = h('button', { class: `hb-slot${i === this.selected ? ' sel' : ''}`, title: it ? `${plain(it.label)}${it.count > 1 ? ` ×${it.count}` : ''}` : `Slot ${i + 1}`, onclick: () => this.selectHotbar(i) },
        it ? this.swatch(it) : null,
        it && it.count > 1 ? h('span', { class: 'count', text: String(it.count) }) : null,
        h('span', { class: 'key', text: String(i + 1) }))
      this.hotbarEl.appendChild(el)
    }
  }

  swatch (it) {
    return h('span', { class: `swatch${it.enchanted ? ' glint' : ''}`, style: { background: rgb(it.color) } })
  }

  showHeld (it) {
    if (!it) { this.heldEl.hidden = true; return }
    clear(this.heldEl).appendChild(renderSegments(it.label, it.name))
    this.flash(this.heldEl, null, 1800)
  }

  flash (el, segments, ms) {
    if (segments) clear(el).appendChild(renderSegments(segments, ''))
    el.hidden = false
    el.classList.remove('fade')
    clearTimeout(el._t)
    el._t = setTimeout(() => el.classList.add('fade'), ms)
  }

  renderChat () {
    const open = document.activeElement === this.chatInput
    const now = Date.now()
    const lines = open ? this.chat.slice(-60) : this.chat.filter(l => now - l.time < 12000).slice(-8)
    clear(this.chatLinesEl)
    for (const l of lines) {
      const el = h('div', { class: `pc-line ${l.kind}${l.level ? ' ' + l.level : ''}` })
      if (l.kind === 'sent') el.appendChild(h('span', { class: 'me', text: '› ' }))
      el.appendChild(l.seg ? renderSegments(l.seg, l.text, l.kind === 'chat' ? (k) => this.chatClick(k, [this.id], el) : null) : document.createTextNode(l.text))
      this.chatLinesEl.appendChild(el)
    }
    if (open) this.chatLinesEl.scrollTop = this.chatLinesEl.scrollHeight
    // fade out older lines without new events
    clearTimeout(this.chatTimer)
    if (!open && lines.length) this.chatTimer = setTimeout(() => this.renderChat(), 2000)
  }

  // a small bar at the top of the view: how to take control (never covers the view)
  renderHint () {
    clear(this.hintEl)
    if (this.window || !this.self) { this.hintEl.hidden = true; return }
    if (this.locked) {
      // a moment after taking the mouse: how to give it back
      if (Date.now() - (this.lockedAt || 0) > 2500) { this.hintEl.hidden = true; return }
      this.hintEl.hidden = false
      this.hintEl.appendChild(h('div', { class: 'pov-hint-bar quiet' }, h('kbd', { text: 'Esc' }), h('span', { text: 'gives the mouse back' })))
      clearTimeout(this.hintTimer)
      this.hintTimer = setTimeout(() => this.renderHint(), 2600)
      return
    }
    this.hintEl.hidden = false
    const refused = Date.now() - (this.refusedAt || 0) < 8000
    const keysOpen = store('povKeys') !== false
    const bar = h('div', { class: 'pov-hint-bar' },
      icon('mouse', 14),
      h('span', { text: refused ? 'Couldn\'t take the mouse. Click again, or drag to look around.' : `Click the view to control ${this.name()}, or drag to look around` }),
      h('button', { class: 'pov-keys-toggle', 'aria-expanded': String(keysOpen), onclick: () => { store('povKeys', !keysOpen); this.renderHint() } }, keysOpen ? 'Hide keys' : 'Keys'))
    this.hintEl.appendChild(bar)
    if (keysOpen) {
      const keys = [['Mouse', 'look around'], ['W A S D', 'walk'], ['Space', 'jump'], ['Shift', 'sneak'], ['Ctrl', 'sprint'], ['Left click', 'hit / break'], ['Right click', 'use / open'], ['1-9, wheel', 'hotbar'], ['E', 'inventory'], ['T or /', 'chat'], ['Esc', 'give the mouse back']]
      this.hintEl.appendChild(h('div', { class: 'pov-keys' }, keys.map(([k, v]) => [h('kbd', { text: k }), h('span', { text: v })])))
    }
  }

  // ------------------------------------------------------------------ menus
  renderMenu (w) {
    this.window = w
    const box = this.menuEl
    clear(box)
    this.tipEl.hidden = true
    if (!w) {
      box.hidden = true
      this.cursorEl.hidden = true
      this.renderHint()
      return
    }
    this.releaseControls()
    if (document.pointerLockElement) document.exitPointerLock()
    box.hidden = false
    this.hintEl.hidden = true
    const grid = (from, to, cols, labelled) => {
      const g = h('div', { class: 'mgrid', style: { gridTemplateColumns: `repeat(${cols}, var(--slot))` } })
      for (let i = from; i < to; i++) g.appendChild(this.slotEl(i, w.slots[i], labelled))
      return g
    }
    const panel = h('div', { class: 'pov-menu-panel', role: 'dialog', 'aria-label': plain(w.title) || 'Menu' })
    panel.appendChild(h('div', { class: 'mhead' },
      h('div', { class: 'mtitle' }, renderSegments(w.title, 'Menu')),
      h('button', { class: 'icon-btn small', title: 'Close (Esc)', 'aria-label': 'Close menu', onclick: () => this.closeMenu() }, icon('close', 14))))
    if (w.own) {
      panel.append(h('div', { class: 'mlabel', text: 'Armour and off-hand' }),
        h('div', { class: 'mrow' }, grid(5, 9, 4, false), grid(45, 46, 1, false)))
    } else if (w.size > 0) {
      panel.appendChild(grid(0, w.size, w.columns, true))
    }
    const inv = w.inventoryStart
    panel.append(h('div', { class: 'mlabel', text: w.own ? 'Inventory' : 'Your inventory' }), grid(inv, inv + 27, 9, false), h('div', { class: 'mgap' }), grid(inv + 27, inv + 36, 9, false))
    panel.appendChild(h('div', { class: 'mfoot muted', text: 'Click to pick up or place · right click for half · Shift+click to move · Esc to close' }))
    box.appendChild(panel)
    // what's on the mouse cursor (picked up from a slot)
    if (w.cursor) {
      clear(this.cursorEl).append(this.swatch(w.cursor), w.cursor.count > 1 ? h('span', { class: 'count', text: String(w.cursor.count) }) : null)
      this.cursorEl.hidden = false
    } else {
      this.cursorEl.hidden = true
    }
    if (this.hoverSlot != null) {
      const el = box.querySelector(`[data-slot="${this.hoverSlot}"]`)
      if (el) this.showTip(el, w.slots[this.hoverSlot])
    }
  }

  slotEl (i, it, labelled) {
    const el = h('button', { class: `mslot${it ? '' : ' empty'}`, dataset: { slot: String(i) }, 'aria-label': it ? plain(it.label) : 'Empty slot' })
    if (it) {
      el.appendChild(this.swatch(it))
      if (it.count > 1) el.appendChild(h('span', { class: 'count', text: String(it.count) }))
      if (labelled && it.custom) el.appendChild(h('span', { class: 'mname' }, renderSegments(it.label, it.name)))
    }
    el.addEventListener('click', (e) => this.clickSlot(i, 0, e.shiftKey))
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.clickSlot(i, 1, e.shiftKey) })
    el.addEventListener('mouseenter', () => { this.hoverSlot = i; this.showTip(el, it) })
    el.addEventListener('mouseleave', () => { this.hoverSlot = null; this.tipEl.hidden = true })
    return el
  }

  showTip (el, it) {
    if (!it) { this.tipEl.hidden = true; return }
    const tip = clear(this.tipEl)
    tip.appendChild(h('div', { class: 'tname' }, renderSegments(it.label, it.name)))
    for (const l of it.lore || []) tip.appendChild(h('div', { class: 'tlore' }, renderSegments(l, '')))
    if (it.count > 1) tip.appendChild(h('div', { class: 'tmeta', text: `×${it.count}` }))
    tip.hidden = false
    const r = el.getBoundingClientRect()
    const s = this.stage.getBoundingClientRect()
    const x = Math.min(r.right - s.left + 8, s.width - tip.offsetWidth - 8)
    const y = Math.max(8, Math.min(r.top - s.top, s.height - tip.offsetHeight - 8))
    tip.style.transform = `translate(${x}px, ${y}px)`
  }

  moveCursor (e) {
    if (this.cursorEl.hidden) return
    const s = this.stage.getBoundingClientRect()
    this.cursorEl.style.transform = `translate(${e.clientX - s.left - 16}px, ${e.clientY - s.top - 16}px)`
  }

  clickSlot (slot, button, shift) {
    api.call('pov', 'click', slot, button, !!shift).catch(() => {})
  }

  closeMenu () {
    api.call('pov', 'closeWindow').catch(() => {})
  }

  toggleInventory () {
    if (!this.self) return
    if (this.window) this.closeMenu()
    else api.call('pov', 'inventory', true).catch(() => {})
  }

  // ------------------------------------------------------------------ input
  onLockChange () {
    const locked = document.pointerLockElement === this.stage
    if (locked === this.locked) return
    this.locked = locked
    if (locked) {
      this.lockedAt = Date.now()
      this.refusedAt = 0
      if (store('povKeys') === null) store('povKeys', false) // seen them once: keep the bar small from now on
      this.drag = null // the click that took the mouse isn't a drag
    } else {
      this.releaseControls()
    }
    this.stage.classList.toggle('locked', locked)
    this.renderHint()
  }

  // Windows/Chromium can refuse to hand over the mouse (the window wasn't focused yet, or
  // it was given back with Esc less than a second ago). Never give up: the next click tries
  // again, and dragging always works meanwhile.
  lockRefused () {
    this.refusedAt = Date.now()
    this.renderHint()
  }

  lock () {
    if (this.window || !this.self) return
    try {
      const p = this.stage.requestPointerLock()
      if (p && p.catch) p.catch(() => this.lockRefused())
    } catch {
      this.lockRefused()
    }
  }

  onMouseDown (e) {
    if (!this.active || this.window || e.target.closest('.pov-chat, .pov-menu, .pov-status-card button, .pov-hotbar, .pov-death, .pov-keys-toggle')) return
    if (document.activeElement === this.chatInput) this.chatInput.blur()
    this.stage.focus()
    if (!this.self) return
    if (!this.locked) {
      // take the mouse; until that happens (or if it's refused), dragging looks around
      e.preventDefault()
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button }
      this.lock()
      return
    }
    this.press(e.button)
  }

  press (button) {
    if (button === 0) { api.call('pov', 'attack', this.yaw, this.pitch).catch(() => {}); this.lookAt = performance.now() }
    if (button === 2) { api.call('pov', 'use', this.yaw, this.pitch).catch(() => {}); this.lookAt = performance.now() }
  }

  onMouseUp (e) {
    if (!this.active) return
    if (this.drag) {
      this.drag = null // a look-around drag (or the click that took the mouse): not a hit
      return
    }
    if (this.locked) this.unpress(e.button)
  }

  unpress (button) {
    if (button === 0) api.call('pov', 'stopDigging').catch(() => {})
    if (button === 2) api.call('pov', 'release').catch(() => {})
  }

  onMouseMove (e) {
    if (!this.active || !this.self) return
    let dx = 0
    let dy = 0
    if (this.locked) {
      dx = e.movementX
      dy = e.movementY
    } else if (this.drag) {
      dx = e.movementX
      dy = e.movementY
      this.drag.moved += Math.abs(dx) + Math.abs(dy)
    } else return
    const k = 0.0022 * this.sensitivity
    this.yaw -= dx * k
    this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch - dy * k))
    this.queueLook()
  }

  queueLook () {
    this.lookAt = performance.now()
    if (this.lookTimer) return
    this.lookTimer = setTimeout(() => {
      this.lookTimer = null
      this.sentYaw = this.yaw
      this.sentPitch = this.pitch
      api.call('pov', 'look', this.yaw, this.pitch).catch(() => {})
    }, 50)
  }

  onWheel (e) {
    if (!this.active || this.window || !this.self) return
    e.preventDefault()
    this.selectHotbar((this.selected + (e.deltaY > 0 ? 1 : 8)) % 9)
  }

  selectHotbar (i) {
    if (!this.self) return
    this.selected = i
    this.showHeld(this.hotbar[i])
    this.renderHotbar()
    api.call('pov', 'hotbar', i).catch(() => {})
  }

  onKey (e, down) {
    if (!this.active || this.modalOpen()) return
    if (isTyping(document.activeElement)) return // typing in the chat box (or elsewhere)
    if (!this.self) return
    const code = e.code
    if (this.window) {
      if (down && (code === 'Escape' || code === 'KeyE')) { e.preventDefault(); this.closeMenu() }
      return
    }
    if (down && code === 'Escape') {
      if (document.pointerLockElement) document.exitPointerLock()
      this.releaseControls()
      return
    }
    if (down && !e.repeat) {
      if (code === 'KeyE') { e.preventDefault(); this.toggleInventory(); return }
      if (code === 'KeyT' || code === 'Enter' || code === 'Slash' || code === 'NumpadDivide') {
        e.preventDefault()
        if (document.pointerLockElement) document.exitPointerLock()
        this.chatInput.value = code === 'Slash' || code === 'NumpadDivide' ? '/' : ''
        this.chatInput.focus()
        return
      }
      const digit = /^Digit([1-9])$/.exec(code)
      if (digit) { e.preventDefault(); this.selectHotbar(Number(digit[1]) - 1); return }
    }
    // movement while the view has the mouse, or after clicking into it (keyboard focus)
    const control = CONTROL_KEYS[code]
    if (!control) return
    if (!this.locked && document.activeElement !== this.stage) return
    e.preventDefault()
    if (e.repeat) return
    this.setControl(control, down)
  }

  setControl (control, on) {
    this.controls = this.controls || {}
    if (!!this.controls[control] === on) return
    this.controls[control] = on
    api.call('pov', 'control', { [control]: on }).catch(() => {})
  }

  releaseControls () {
    const held = Object.entries(this.controls || {}).filter(([, v]) => v)
    if (!held.length) return
    this.controls = {}
    api.call('pov', 'control', Object.fromEntries(held.map(([k]) => [k, false]))).catch(() => {})
  }

  /** a "suggest command" chat click: put the text in the chat box */
  suggest (text) {
    this.chatInput.value = text
    this.chatInput.focus()
  }

  sendChat () {
    const text = this.chatInput.value.trim()
    this.chatInput.value = ''
    this.chatInput.blur()
    if (text && this.id) {
      api.call('sendChat', text, [this.id]).catch(() => {})
      if (!SECRET_COMMAND.test(text)) {
        this.sentHistory = this.sentHistory.filter(t => t !== text).concat(text).slice(-50)
      }
    }
    this.historyAt = -1
    this.stage.focus()
    this.lock()
  }
}
