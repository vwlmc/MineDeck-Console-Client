'use strict'
// POV: streams what one account sees (nearby blocks, players and mobs, its own
// state, open menus) to the window, and lets the window steer it: look around,
// walk, use and attack, pick hotbar slots, and click items in server menus.
//
// Everything sent to the window is plain data (numbers, colours and text
// segments). Nothing here touches sign-in tokens.
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { KIND, blockAppearance, colorFor } = require('./block-colors')
const { toSegments, parseLegacy } = require('./chat-format')

const RADIUS = 4 // chunk columns around the player (MineDeck's smallest view distance is 6)
const VERTICAL = 32 // blocks above and below the player
const ENTITY_RANGE = 48
const MAX_ENTITIES = 150
const SECTIONS_PER_BATCH = 12
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// any text from the server (JSON string, legacy "§" string, NBT, ChatMessage or object) -> segments
function textSegments (value, lang) {
  try {
    if (value == null) return []
    if (typeof value === 'object' && 'type' in value && 'value' in value) value = nbt.simplify(value)
    if (typeof value === 'string') {
      const t = value.trim()
      if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
        try { return toSegments(JSON.parse(t), lang) } catch { }
      }
      return parseLegacy(value)
    }
    if (value.json && typeof value.json === 'object') value = value.json // prismarine-chat ChatMessage
    return toSegments(value, lang)
  } catch {
    return [{ t: String(value).slice(0, 200) }]
  }
}

function itemInfo (item, lang) {
  if (!item) return null
  let label = null
  let lore = []
  let enchanted = false
  try { if (item.customName) label = textSegments(item.customName, lang) } catch { }
  const custom = !!label && label.some(s => s.t && s.t.trim())
  try {
    let l = item.customLore
    if (typeof l === 'string') l = l.split('\n')
    if (Array.isArray(l)) lore = l.slice(0, 20).map(x => textSegments(x, lang))
  } catch { }
  try { enchanted = Array.isArray(item.enchants) && item.enchants.length > 0 } catch { }
  return {
    name: item.name,
    label: label && label.length ? label : [{ t: item.displayName || item.name }],
    custom,
    count: item.count,
    color: colorFor(item.name, item.metadata || 0),
    lore,
    enchanted
  }
}

function windowColumns (type, size) {
  const t = String(type || '')
  if (/hopper/.test(t)) return 5
  if (/dispenser|dropper|crafter|3x3/.test(t)) return 3
  if (size > 0 && size < 9) return size
  return 9
}

class PovController {
  /**
   * @param {object} session  a connected Session (session.bot is the mineflayer bot)
   * @param {(kind: string, data: any) => void} send  delivers updates to the window
   */
  constructor (session, send) {
    this.session = session
    this.bot = session.bot
    this.registry = this.bot.registry
    this.lang = session.lang || null
    this.legacyStates = !this.registry.supportFeature('blockStateId')
    this.send = send
    this.palette = new Map() // stateId -> palette index (0 = nothing to draw)
    this.newPalette = []
    this.sent = new Set() // "cx,cy,cz" sections the window has
    this.queue = [] // sections waiting to be sent
    this.dirty = new Set()
    this.listeners = []
    this.timers = []
    this.showingInventory = false
    this.stopped = false
  }

  // ------------------------------------------------------------ lifecycle
  start () {
    const bot = this.bot
    this.on(bot, 'chunkColumnLoad', () => this.scheduleRangeCheck())
    this.on(bot, 'chunkColumnUnload', (p) => this.dropColumn(Math.floor(p.x / 16), Math.floor(p.z / 16)))
    this.on(bot, 'blockUpdate', (oldBlock, newBlock) => {
      const p = (newBlock || oldBlock)?.position
      if (!p) return
      const key = `${Math.floor(p.x / 16)},${Math.floor(p.y / 16)},${Math.floor(p.z / 16)}`
      if (this.sent.has(key)) this.dirty.add(key)
    })
    this.on(bot, 'respawn', () => this.reset()) // also fires on dimension changes
    this.on(bot, 'windowOpen', (w) => this.watchWindow(w))
    // closing a container copies its inventory part back into the player's inventory
    this.on(bot, 'windowClose', () => { this.window = null; this.sendWindow(); this.scheduleInventory() })
    this.on(bot, 'heldItemChanged', () => this.scheduleInventory())
    this.on(bot.inventory, 'updateSlot', () => { this.scheduleInventory(); if (this.showingInventory) this.scheduleWindow() })
    this.on(bot, 'actionBar', (msg) => this.send('actionbar', textSegments(msg, this.lang)))
    this.on(bot, 'title', (text, type) => this.send('title', { type: String(type || 'title'), text: textSegments(text, this.lang) }))
    this.on(bot, 'title_clear', () => this.send('title', null))
    this.on(bot, 'end', () => this.stop('disconnected'))
    this.session.povActive = true // anti-AFK stays out of the way while someone is steering

    this.send('init', {
      version: bot.version,
      minY: bot.game?.minY ?? 0,
      height: bot.game?.height ?? 256,
      dimension: String(bot.game?.dimension || 'overworld').replace('minecraft:', ''),
      radius: RADIUS
    })
    // own position on every physics step (20 per second) so the view moves smoothly; others less often
    this.on(bot, 'physicsTick', () => this.sendSelf())
    this.timers.push(setInterval(() => this.sendSelf(), 250)) // physics pauses while dead or before spawn
    this.timers.push(setInterval(() => this.tick(), 100))
    this.timers.push(setInterval(() => this.rangeCheck(), 1000))
    this.timers.push(setInterval(() => this.pump(), 40))
    this.rangeCheck()
    this.sendInventory()
    if (bot.currentWindow) this.watchWindow(bot.currentWindow)
  }

  stop (reason = 'closed') {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    for (const t of [this.rangeTimer, this.invTimer, this.winTimer]) clearTimeout(t)
    for (const [emitter, event, fn] of this.listeners) emitter.removeListener(event, fn)
    this.listeners = []
    if (this.window && this.windowListener) this.window.removeListener('updateSlot', this.windowListener)
    try { this.bot.clearControlStates() } catch { }
    this.session.povActive = false
    this.send('end', { reason })
  }

  on (emitter, event, fn) {
    emitter.on(event, fn)
    this.listeners.push([emitter, event, fn])
  }

  reset () {
    this.sent.clear()
    this.queue = []
    this.dirty.clear()
    this.send('reset', {
      minY: this.bot.game?.minY ?? 0,
      height: this.bot.game?.height ?? 256,
      dimension: String(this.bot.game?.dimension || 'overworld').replace('minecraft:', '')
    })
    this.scheduleRangeCheck()
  }

  // ------------------------------------------------------------ world
  scheduleRangeCheck () {
    if (this.rangeTimer || this.stopped) return
    this.rangeTimer = setTimeout(() => { this.rangeTimer = null; this.rangeCheck() }, 150)
  }

  center () {
    const p = this.bot.entity?.position
    return p ? { cx: Math.floor(p.x / 16), cy: Math.floor(p.y / 16), cz: Math.floor(p.z / 16), y: p.y } : null
  }

  sectionRange (y) {
    const minY = this.bot.game?.minY ?? 0
    const maxY = minY + (this.bot.game?.height ?? 256) - 1
    return [Math.floor(Math.max(minY, y - VERTICAL) / 16), Math.floor(Math.min(maxY, y + VERTICAL) / 16)]
  }

  // which sections should the window have now? queue the missing ones, drop far ones
  rangeCheck () {
    if (this.stopped) return
    const c = this.center()
    const world = this.bot.world
    if (!c || !world) return
    const [cy0, cy1] = this.sectionRange(c.y)
    const wanted = new Set()
    const order = []
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        const cx = c.cx + dx
        const cz = c.cz + dz
        if (!world.getColumn(cx, cz)) continue
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = `${cx},${cy},${cz}`
          wanted.add(key)
          if (!this.sent.has(key) && !this.queue.includes(key)) order.push([dx * dx + dz * dz + (cy - c.cy) * (cy - c.cy), key])
        }
      }
    }
    order.sort((a, b) => a[0] - b[0])
    for (const [, key] of order) this.queue.push(key)
    const drop = []
    for (const key of this.sent) {
      const [cx, cy, cz] = key.split(',').map(Number)
      if (Math.abs(cx - c.cx) > RADIUS + 1 || Math.abs(cz - c.cz) > RADIUS + 1 || cy < cy0 - 1 || cy > cy1 + 1) drop.push(key)
    }
    if (drop.length) {
      for (const key of drop) this.sent.delete(key)
      this.send('drop', drop)
    }
    this.queue = this.queue.filter(k => wanted.has(k))
  }

  dropColumn (cx, cz) {
    const drop = [...this.sent].filter(k => { const [x, , z] = k.split(','); return Number(x) === cx && Number(z) === cz })
    for (const key of drop) this.sent.delete(key)
    this.queue = this.queue.filter(k => { const [x, , z] = k.split(','); return !(Number(x) === cx && Number(z) === cz) })
    if (drop.length) this.send('drop', drop)
  }

  // send a few queued or changed sections at a time, so the main process stays responsive
  pump () {
    if (this.stopped) return
    const out = []
    for (const key of this.dirty) {
      if (out.length >= SECTIONS_PER_BATCH) break
      this.dirty.delete(key)
      const s = this.extract(key)
      if (s) out.push(s)
    }
    while (out.length < SECTIONS_PER_BATCH && this.queue.length) {
      const key = this.queue.shift()
      const s = this.extract(key)
      if (s) { out.push(s); this.sent.add(key) }
    }
    if (out.length) {
      const palette = this.newPalette
      this.newPalette = []
      this.send('sections', { palette, sections: out })
    }
  }

  paletteIndex (stateId) {
    let i = this.palette.get(stateId)
    if (i !== undefined) return i
    const block = this.registry.blocksByStateId[stateId] || (this.legacyStates ? this.registry.blocks[stateId >> 4] : null)
    const look = blockAppearance(block, this.legacyStates ? stateId & 15 : 0)
    if (look.kind === KIND.AIR) i = 0
    else {
      i = this.palette.size + 1
      this.newPalette.push({ i, color: look.color, top: look.top || null, box: look.box || null, kind: look.kind, alpha: look.alpha, name: block ? block.name : String(stateId) })
    }
    this.palette.set(stateId, i)
    return i
  }

  extract (key) {
    const [cx, cy, cz] = key.split(',').map(Number)
    const column = this.bot.world?.getColumn(cx, cz)
    if (!column) return null
    const data = new Uint16Array(4096)
    const pos = new Vec3(0, 0, 0) // older chunk formats need a real Vec3
    let filled = 0
    try {
      for (let y = 0; y < 16; y++) {
        pos.y = cy * 16 + y
        for (let z = 0; z < 16; z++) {
          pos.z = z
          for (let x = 0; x < 16; x++) {
            pos.x = x
            const i = this.paletteIndex(column.getBlockStateId(pos))
            if (i) { data[(y * 16 + z) * 16 + x] = i; filled++ }
          }
        }
      }
    } catch {
      return null
    }
    return { cx, cy, cz, data: filled ? data : null }
  }

  // ------------------------------------------------------------ entities, self
  sendSelf () {
    if (this.stopped) return
    const bot = this.bot
    const me = bot.entity
    if (!me || !me.position) return
    const now = Date.now()
    if (now - (this.selfAt || 0) < 40) return
    this.selfAt = now
    this.send('self', {
      x: me.position.x,
      y: me.position.y,
      z: me.position.z,
      yaw: me.yaw,
      pitch: me.pitch,
      onGround: !!me.onGround,
      sneaking: !!bot.getControlState?.('sneak'),
      health: bot.health,
      alive: bot.isAlive !== false,
      food: bot.food,
      level: bot.experience?.level ?? 0,
      gameMode: bot.game?.gameMode || null,
      dimension: String(bot.game?.dimension || '').replace('minecraft:', ''),
      time: bot.time?.timeOfDay
    })
  }

  tick () {
    if (this.stopped) return
    const bot = this.bot
    const me = bot.entity
    if (!me || !me.position) return
    const entities = []
    for (const e of Object.values(bot.entities)) {
      if (e === me || !e.position || !e.isValid) continue
      const d = e.position.distanceTo(me.position)
      if (d > ENTITY_RANGE) continue
      entities.push([d, e])
    }
    entities.sort((a, b) => a[0] - b[0])
    this.send('entities', entities.slice(0, MAX_ENTITIES).map(([d, e]) => this.describeEntity(e, d)))
  }

  describeEntity (e, distance) {
    const type = String(e.type || '')
    let kind = 'object'
    let name = e.displayName || e.name || 'Entity'
    let color = null
    if (type === 'player') { kind = 'player'; name = e.username || name } else if (/^item$/i.test(e.name || '')) {
      kind = 'item'
      try { const it = e.getDroppedItem?.(); if (it) { name = it.displayName || it.name; color = colorFor(it.name, it.metadata || 0) } } catch { }
    } else if (type === 'hostile' || e.kind === 'Hostile mobs') kind = 'hostile'
    else if (/mob|animal|passive|water_creature|ambient/.test(type)) kind = 'mob'
    // custom names: holograms (invisible armour stands), named mobs, NPCs
    const meta = e.metadata || []
    const invisible = typeof meta[0] === 'number' && (meta[0] & 0x20) !== 0
    let tag = null
    try {
      if (meta[2] && (meta[3] === true || meta[3] === 1 || kind !== 'object')) {
        const seg = textSegments(meta[2], this.lang)
        if (seg.some(x => x.t && x.t.trim())) tag = seg.slice(0, 30)
      }
    } catch { }
    return {
      id: e.id,
      kind,
      type: String(e.name || ''),
      yaw: Number(e.yaw) || 0,
      name: String(name).slice(0, 40),
      tag,
      invisible,
      color,
      x: e.position.x,
      y: e.position.y,
      z: e.position.z,
      w: Math.min(5, Number(e.width) || 0.6),
      h: Math.min(5, Number(e.height) || 1.8),
      d: Math.round(distance)
    }
  }

  // ------------------------------------------------------------ hotbar and menus
  scheduleInventory () {
    if (this.invTimer || this.stopped) return
    this.invTimer = setTimeout(() => { this.invTimer = null; this.sendInventory() }, 80)
  }

  sendInventory () {
    const inv = this.bot.inventory
    const start = inv.hotbarStart ?? 36
    this.send('inventory', {
      hotbar: Array.from({ length: 9 }, (_, i) => itemInfo(inv.slots[start + i], this.lang)),
      selected: this.bot.quickBarSlot ?? 0
    })
  }

  watchWindow (w) {
    if (this.window && this.windowListener) this.window.removeListener('updateSlot', this.windowListener)
    this.window = w
    this.showingInventory = false
    this.windowListener = () => this.scheduleWindow()
    w.on('updateSlot', this.windowListener)
    this.sendWindow()
  }

  scheduleWindow () {
    if (this.winTimer || this.stopped) return
    this.winTimer = setTimeout(() => { this.winTimer = null; this.sendWindow() }, 60)
  }

  sendWindow () {
    const w = this.window || (this.showingInventory ? this.bot.inventory : null)
    if (!w) return this.send('window', null)
    const own = w === this.bot.inventory
    const size = own ? 0 : w.inventoryStart
    this.send('window', {
      id: w.id,
      own,
      title: own ? [{ t: 'Inventory' }] : textSegments(w.title, this.lang),
      type: String(w.type || ''),
      size,
      columns: windowColumns(w.type, size),
      inventoryStart: own ? 9 : w.inventoryStart,
      inventoryEnd: own ? 45 : w.inventoryEnd,
      slots: w.slots.slice(0, own ? 46 : w.inventoryEnd).map(it => itemInfo(it, this.lang)),
      cursor: itemInfo(w.selectedItem, this.lang)
    })
  }

  // ------------------------------------------------------------ controls
  look (yaw, pitch) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !this.bot.entity) return false
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
    this.bot.look(yaw, pitch, true).catch(() => {})
    return true
  }

  control (state) {
    for (const k of CONTROLS) {
      if (typeof state[k] === 'boolean') this.bot.setControlState(k, state[k])
    }
    return true
  }

  hotbar (n) {
    this.bot.setQuickBarSlot(n)
    return true
  }

  use (yaw, pitch) {
    const bot = this.bot
    this.look(yaw, pitch)
    const entity = bot.entityAtCursor(4)
    if (entity) {
      Promise.resolve(bot.activateEntity(entity)).catch(() => {})
      return 'entity'
    }
    const block = bot.blockAtCursor(5)
    if (block) {
      Promise.resolve(bot.activateBlock(block)).catch(() => {})
      return 'block'
    }
    bot.activateItem() // eat, drink, draw a bow... until the button is released
    return 'item'
  }

  respawn () {
    if (this.bot.isAlive === false) this.bot.respawn()
    return true
  }

  // right button released
  release () {
    if (this.bot.usingHeldItem) this.bot.deactivateItem()
    return true
  }

  // left click: hit what's under the crosshair, or start breaking the block there
  attack (yaw, pitch) {
    const bot = this.bot
    this.look(yaw, pitch)
    const entity = bot.entityAtCursor(3.5)
    if (entity) { bot.attack(entity); return 'entity' }
    const block = bot.blockAtCursor(4.5)
    if (block && block.diggable !== false && !bot.targetDigBlock) {
      Promise.resolve(bot.dig(block, false)).catch(() => {})
      return 'dig'
    }
    bot.swingArm()
    return 'swing'
  }

  // left button released
  stopDigging () {
    if (this.bot.targetDigBlock) {
      try { this.bot.stopDigging() } catch { }
    }
    return true
  }

  click (slot, button, shift) {
    const w = this.window || (this.showingInventory ? this.bot.inventory : null)
    if (!w || slot >= w.slots.length) return false
    Promise.resolve(this.bot.clickWindow(slot, button, shift ? 1 : 0)).catch(() => {})
    return true
  }

  closeWindow () {
    if (this.window) {
      try { this.bot.closeWindow(this.window) } catch { }
    } else if (this.showingInventory) {
      this.showingInventory = false
      this.sendWindow()
    }
    return true
  }

  showInventory (on) {
    if (this.window) return false
    this.showingInventory = !!on
    this.sendWindow()
    return true
  }
}

// One POV at a time: which account is being watched, re-attached when it reconnects.
class PovHost {
  /**
   * @param {import('./manager').Manager} manager
   * @param {(payload: {id: string, kind: string, data: any}) => void} send
   */
  constructor (manager, send) {
    this.manager = manager
    this.send = send
    this.id = null
    this.controller = null
    manager.on('spawn', (id, session) => {
      if (id === this.id && (!this.controller || this.controller.stopped || this.controller.session !== session)) this.attach()
    })
  }

  open (id) {
    this.close()
    if (!this.manager.slots.has(id)) return { ok: false, reason: 'That account is not in MineDeck.' }
    this.id = id
    return this.attach()
  }

  attach () {
    if (this.controller && !this.controller.stopped) this.controller.stop('switched')
    this.controller = null
    const id = this.id
    const session = this.manager.slots.get(id)?.session
    if (session && session.version?.engine === 'legacy') {
      this.send({ id, kind: 'unsupported', data: 'POV needs Minecraft 1.8 or newer. This server is joined with 1.7.10.' })
      return { ok: false, reason: 'POV needs Minecraft 1.8 or newer.' }
    }
    if (!session || session.state !== 'online' || !session.bot?.entity) {
      this.send({ id, kind: 'waiting', data: null })
      return { ok: true, waiting: true }
    }
    const controller = new PovController(session, (kind, data) => {
      if (this.controller === controller) this.send({ id, kind, data })
    })
    this.controller = controller
    controller.start()
    return { ok: true, waiting: false }
  }

  close () {
    const c = this.controller
    this.controller = null
    this.id = null
    if (c && !c.stopped) c.stop('closed')
  }

  /** Input from the POV view. Everything is checked here: the window only ever sends plain values. */
  action (name, a, b, c) {
    const pov = this.controller
    if (!pov || pov.stopped) return false
    const num = (v) => typeof v === 'number' && Number.isFinite(v)
    try {
      switch (name) {
        case 'look': return num(a) && num(b) && pov.look(a, b)
        case 'control': return !!a && typeof a === 'object' && !Array.isArray(a) && pov.control(a)
        case 'hotbar': return Number.isInteger(a) && a >= 0 && a <= 8 && pov.hotbar(a)
        case 'use': return num(a) && num(b) && pov.use(a, b)
        case 'attack': return num(a) && num(b) && pov.attack(a, b)
        case 'stopDigging': return pov.stopDigging()
        case 'release': return pov.release()
        case 'respawn': return pov.respawn()
        case 'click': return Number.isInteger(a) && a >= 0 && a < 200 && (b === 0 || b === 1) && pov.click(a, b, c === true)
        case 'closeWindow': return pov.closeWindow()
        case 'inventory': return pov.showInventory(a === true)
        default: return false
      }
    } catch (e) {
      console.error('[pov]', name, e)
      return false
    }
  }
}

module.exports = { PovController, PovHost, textSegments, itemInfo, RADIUS }
