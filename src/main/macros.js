'use strict'
// Macros: what they look like, and the checks every macro passes before it is
// saved or run. A macro is data only (a list of steps from a fixed menu), never
// code, so a macro shared by someone else can't do anything except the steps
// listed here: it can't read files, reach the internet or touch sign-ins.
const { randomBytes } = require('crypto')

const ID_RE = /^mac_[0-9a-f]{12}$/
const MAX_STEPS = 500
const MAX_MACROS = 200
const SHARE_PREFIX = 'MineDeck macro v1:'

const newMacroId = () => `mac_${randomBytes(6).toString('hex')}`

// ------------------------------------------------------------------ field helpers
const text = (max, def = '') => (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : def)
const num = (min, max, def) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}
const optNum = (min, max) => (v) => (v === null || v === undefined || v === '' ? null : num(min, max, null)(v))
const int = (min, max, def) => (v) => { const n = num(min, max, def)(v); return n === null ? null : Math.round(n) }
const optInt = (min, max) => (v) => { const n = optNum(min, max)(v); return n === null ? null : Math.round(n) }
const oneOf = (list, def = list[0]) => (v) => (list.includes(v) ? v : def)
const bool = (def = false) => (v) => (typeof v === 'boolean' ? v : def)
const VAR_NAME = /^[a-z][a-z0-9_]{0,19}$/i

// every step type and its fields (with defaults); anything else is dropped
const STEPS = {
  chat: { text: text(256) },
  wait: { sec: num(0, 86400, 1), max: optNum(0, 86400) },
  waitChat: { match: text(200), timeout: num(0.1, 86400, 30), onTimeout: oneOf(['continue', 'stop']) },
  waitMenu: { match: text(100), timeout: num(0.1, 86400, 10), onTimeout: oneOf(['continue', 'stop']) },
  click: { match: text(100), slot: optInt(0, 199), button: oneOf(['left', 'right']), shift: bool(), wait: num(0, 120, 5), onFail: oneOf(['continue', 'stop']) },
  closeMenu: {},
  use: { hold: num(0, 30, 0) },
  attack: { target: oneOf(['crosshair', 'hostile', 'mob', 'player', 'name']), name: text(64), range: num(1, 6, 4) },
  hotbar: { slot: int(1, 9, 1) },
  equip: { item: text(64) },
  eat: { below: int(1, 20, 18) },
  drop: { item: text(64), all: bool() },
  fish: { timeout: num(5, 600, 60) },
  look: { mode: oneOf(['direction', 'turn', 'nearest', 'position']), dir: oneOf(['north', 'east', 'south', 'west']), pitch: num(-90, 90, 0), turn: num(-360, 360, 90), target: oneOf(['player', 'mob', 'hostile']), x: num(-3e7, 3e7, 0), y: num(-2048, 2048, 64), z: num(-3e7, 3e7, 0) },
  move: { dir: oneOf(['forward', 'back', 'left', 'right']), sec: num(0.05, 3600, 1), sprint: bool(), jump: bool() },
  goto: { x: num(-3e7, 3e7, 0), z: num(-3e7, 3e7, 0), timeout: num(1, 3600, 30), sprint: bool() },
  control: { action: oneOf(['jump', 'sneakOn', 'sneakOff', 'sprintOn', 'sprintOff']) },
  respawn: {},
  repeat: { times: int(0, 1000000, 5) },
  if: {
    cond: oneOf(['health', 'food', 'item', 'menu', 'chat', 'chance', 'text']),
    not: bool(),
    value: num(0, 100, 10),
    item: text(64),
    count: int(1, 100000, 1),
    match: text(200),
    within: num(1, 86400, 10),
    left: text(256),
    op: oneOf(['equals', 'contains']),
    right: text(256)
  },
  else: {},
  end: {},
  set: { name: (v) => (typeof v === 'string' && VAR_NAME.test(v) ? v : 'value'), value: text(256) },
  run: { macro: (v) => (typeof v === 'string' && ID_RE.test(v) ? v : '') },
  log: { text: text(256), notify: bool() },
  stop: {},
  disconnect: {}
}

const TRIGGERS = ['manual', 'join', 'chat', 'interval', 'menu', 'death', 'health']
const HOTKEYS = ['', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']

function cleanStep (input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(STEPS, input.type)) return null
  const step = { type: input.type }
  for (const [key, check] of Object.entries(STEPS[input.type])) step[key] = check(Object.hasOwn(input, key) ? input[key] : undefined)
  return step
}

// every Repeat and If gets its End, Else only inside an If, stray Ends dropped
function repairBlocks (steps) {
  const out = []
  const open = [] // { type, sawElse }
  for (const s of steps) {
    if (s.type === 'repeat' || s.type === 'if') {
      open.push({ type: s.type, sawElse: false })
      out.push(s)
    } else if (s.type === 'else') {
      const top = open[open.length - 1]
      if (!top || top.type !== 'if' || top.sawElse) continue
      top.sawElse = true
      out.push(s)
    } else if (s.type === 'end') {
      if (!open.length) continue
      open.pop()
      out.push(s)
    } else {
      out.push(s)
    }
  }
  while (open.length) { open.pop(); out.push({ type: 'end' }) }
  return out
}

function cleanTrigger (t) {
  t = t && typeof t === 'object' ? t : {}
  return {
    type: oneOf(TRIGGERS)(t.type),
    match: text(200)(t.match),
    every: num(0.05, 10080, 5)(t.every), // minutes
    jitter: num(0, 90, 0)(t.jitter), // percent
    delay: num(0, 600, 3)(t.delay), // seconds after joining
    below: num(1, 20, 8)(t.below), // health
    cooldown: num(0, 86400, 5)(t.cooldown) // seconds
  }
}

/** a macro from the window, an import or a template -> a safe, complete macro (throws if hopeless) */
function cleanMacro (input, { keepId = true } = {}) {
  if (!input || typeof input !== 'object') throw new Error('not a macro')
  const steps = repairBlocks((Array.isArray(input.steps) ? input.steps : []).slice(0, MAX_STEPS).map(cleanStep).filter(Boolean))
  let accounts = 'all'
  if (Array.isArray(input.accounts)) accounts = [...new Set(input.accounts.filter(a => typeof a === 'string' && /^[a-z]{3}_[0-9a-f]{12}$/.test(a)))].slice(0, 500)
  return {
    id: keepId && typeof input.id === 'string' && ID_RE.test(input.id) ? input.id : newMacroId(),
    name: text(60, '')(input.name).trim() || 'New macro',
    notes: text(500)(input.notes),
    accounts,
    trigger: cleanTrigger(input.trigger),
    hotkey: oneOf(HOTKEYS, '')(input.hotkey),
    enabled: bool(false)(input.enabled),
    loop: bool(false)(input.loop),
    loopDelay: num(0, 86400, 1)(input.loopDelay),
    stagger: num(0, 600, 1)(input.stagger),
    onReconnect: oneOf(['stop', 'restart'])(input.onReconnect),
    steps
  }
}

/** text to share a macro with someone (MineDeck can import it) */
function shareText (macro) {
  const shared = { ...macro, accounts: 'all' } // account ids mean nothing on another PC
  delete shared.id
  return `${SHARE_PREFIX}${JSON.stringify(shared)}`
}

/** shared text -> a new macro. Imported macros start with their automatic start switched off. */
function parseShared (input) {
  const s = String(input || '').trim()
  if (s.length > 200000) throw new Error('That text is too long to be a macro.')
  const json = s.startsWith(SHARE_PREFIX) ? s.slice(SHARE_PREFIX.length) : s
  let data
  try { data = JSON.parse(json) } catch { throw new Error('That isn\'t a MineDeck macro. Copy it with "Share" in MineDeck and paste the whole text.') }
  const macro = cleanMacro(data, { keepId: false })
  macro.enabled = false
  macro.accounts = 'all'
  return macro
}

// ------------------------------------------------------------------ templates
const T = (key, title, description, macro) => ({ key, title, description, macro })
const TEMPLATES = [
  T('server-menu', 'Join a game mode from the hub menu', 'Right-clicks the item in hotbar slot 1 (usually a compass) and clicks a game mode in the menu that opens.', {
    name: 'Join Survival from the hub',
    trigger: { type: 'join', delay: 3 },
    steps: [
      { type: 'hotbar', slot: 1 },
      { type: 'use' },
      { type: 'click', match: 'Survival', wait: 5 },
      { type: 'waitChat', match: 'survival', timeout: 15 }
    ]
  }),
  T('afk-fish', 'AFK fishing', 'Holds a fishing rod and fishes forever, eating when hungry. Stand facing water.', {
    name: 'AFK fishing',
    onReconnect: 'restart',
    steps: [
      { type: 'equip', item: 'fishing rod' },
      { type: 'repeat', times: 0 },
      { type: 'eat', below: 14 },
      { type: 'equip', item: 'fishing rod' },
      { type: 'fish', timeout: 60 },
      { type: 'wait', sec: 0.5, max: 1.5 },
      { type: 'end' }
    ]
  }),
  T('mob-grinder', 'Mob farm attacker', 'Attacks the nearest hostile mob within reach, over and over, with a sword. Eats when hungry.', {
    name: 'Mob farm attacker',
    onReconnect: 'restart',
    steps: [
      { type: 'equip', item: 'sword' },
      { type: 'repeat', times: 0 },
      { type: 'attack', target: 'hostile', range: 4 },
      { type: 'wait', sec: 0.65 },
      { type: 'if', cond: 'food', value: 14 },
      { type: 'eat', below: 14 },
      { type: 'equip', item: 'sword' },
      { type: 'end' },
      { type: 'end' }
    ]
  }),
  T('auto-eat', 'Eat when hungry', 'Every 30 seconds, eats something if hunger is below 16 (any food in the inventory).', {
    name: 'Eat when hungry',
    trigger: { type: 'interval', every: 0.5 },
    steps: [{ type: 'eat', below: 16 }]
  }),
  T('daily-reward', 'Claim a daily reward', 'Runs /daily every 24 hours and clicks "Claim" if a menu opens.', {
    name: 'Claim daily reward',
    trigger: { type: 'interval', every: 1440, jitter: 2 },
    steps: [
      { type: 'chat', text: '/daily' },
      { type: 'click', match: 'Claim', wait: 5 },
      { type: 'closeMenu' }
    ]
  }),
  T('sell-all', 'Sell everything every 10 minutes', 'Runs /sell all every 10 minutes, a little randomly so accounts don\'t all do it at once.', {
    name: 'Sell all',
    trigger: { type: 'interval', every: 10, jitter: 10 },
    steps: [{ type: 'chat', text: '/sell all' }]
  }),
  T('tpaccept', 'Accept teleport requests', 'When someone asks to teleport to the account, accepts it. {1} is the player\'s name.', {
    name: 'Accept teleport requests',
    trigger: { type: 'chat', match: '* has requested to teleport to you', cooldown: 3 },
    steps: [{ type: 'chat', text: '/tpaccept {1}' }]
  }),
  T('auto-reply', 'Reply to private messages', 'Answers private messages while you\'re away. Change the pattern to match your server\'s message format.', {
    name: 'Away reply',
    trigger: { type: 'chat', match: '[* -> me] *', cooldown: 30 },
    steps: [{ type: 'chat', text: '/r I\'m away right now, back soon!' }]
  }),
  T('auto-confirm', 'Confirm menus automatically', 'When a menu with "Confirm" in its title opens, clicks the item named "Confirm".', {
    name: 'Auto-confirm',
    trigger: { type: 'menu', match: 'Confirm', cooldown: 1 },
    steps: [{ type: 'click', match: 'Confirm', wait: 2 }]
  }),
  T('join-alert', 'Tell me when someone joins', 'Pops up a notice and flashes the taskbar when a player joins the server.', {
    name: 'Join alert',
    accounts: 'all',
    trigger: { type: 'chat', match: '* joined the game', cooldown: 2 },
    steps: [{ type: 'log', text: '{1} joined the server', notify: true }]
  }),
  T('low-health', 'Leave when health is low', 'If health drops below 6 (3 hearts), says so in the chat window and disconnects the account.', {
    name: 'Leave on low health',
    trigger: { type: 'health', below: 6, cooldown: 10 },
    steps: [{ type: 'log', text: 'Health was low ({health}), disconnecting', notify: true }, { type: 'disconnect' }]
  }),
  T('walk-loop', 'Walk back and forth', 'Walks forward and back for 3 seconds each, forever. Handy to stay active.', {
    name: 'Walk back and forth',
    onReconnect: 'restart',
    steps: [
      { type: 'repeat', times: 0 },
      { type: 'move', dir: 'forward', sec: 3 },
      { type: 'wait', sec: 0.5 },
      { type: 'move', dir: 'back', sec: 3 },
      { type: 'wait', sec: 0.5 },
      { type: 'end' }
    ]
  })
]

function fromTemplate (key) {
  const t = TEMPLATES.find(x => x.key === key)
  if (!t) throw new Error('unknown template')
  return cleanMacro({ ...t.macro, notes: t.description }, { keepId: false })
}

module.exports = { cleanMacro, cleanStep, repairBlocks, shareText, parseShared, fromTemplate, TEMPLATES, STEPS, MAX_MACROS, ID_RE, newMacroId }
