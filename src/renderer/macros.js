// Macros tab: make, edit, run and watch macros. A macro is a list of steps
// (say, wait, click in a menu, walk, attack...) that runs on one or more
// accounts, by hand or by itself when something happens. Everything here is
// sent to the main process, which checks it again before saving or running.
import { h, clear, clock } from './ui.js'
import { icon } from './icons.js'
import { openModal, confirmDialog } from './modals.js'

const api = window.minedeck
const CATEGORIES = ['Chat', 'Wait', 'Menus', 'Actions', 'Items', 'Movement', 'Flow']
const CONTINUE_OR_STOP = [['continue', 'carry on'], ['stop', 'stop the macro']]
const per = (s) => (s.cond === 'chance' ? '%' : '/ 20')

// ------------------------------------------------------------------ what each step looks like
// fields: k key, t type (text|num|sel|bool|macro), pre/post words around it, ph placeholder,
// w width (s|m|l|grow), adv = on the second, smaller line, when = only shown if, re = redraw on change
const STEP_UI = {
  chat: { cat: 'Chat', icon: 'chat', label: 'Say', def: { text: '' }, help: 'Sends a message or a /command from the account.', fields: [{ k: 'text', t: 'text', w: 'grow', ph: 'Message or /command. {account}, {x} {y} {z}, {1}… are filled in' }] },
  wait: { cat: 'Wait', icon: 'clock', label: 'Wait', def: { sec: 1, max: null }, help: 'Pauses. With a second number it waits a random time between the two.', fields: [{ k: 'sec', t: 'num', min: 0, step: 0.1 }, { k: 'max', t: 'num', pre: 'to', ph: '–', min: 0, step: 0.1, opt: true }, { k: '_', t: 'word', post: 'seconds' }] },
  waitChat: { cat: 'Wait', icon: 'chat', label: 'Wait for chat', def: { match: '', timeout: 30, onTimeout: 'continue' }, help: 'Waits until a chat message contains this text. * stands for anything and is saved as {1}, {2}…', fields: [{ k: 'match', t: 'text', w: 'l', ph: 'e.g. * has joined' }, { k: 'timeout', t: 'num', pre: 'for up to', post: 's', min: 0.1, adv: true }, { k: 'onTimeout', t: 'sel', pre: 'if it doesn\'t come,', opts: CONTINUE_OR_STOP, adv: true }] },
  waitMenu: { cat: 'Wait', icon: 'grid', label: 'Wait for a menu', def: { match: '', timeout: 10, onTimeout: 'continue' }, fields: [{ k: 'match', t: 'text', w: 'm', ph: 'title contains (optional)' }, { k: 'timeout', t: 'num', pre: 'for up to', post: 's', min: 0.1, adv: true }, { k: 'onTimeout', t: 'sel', pre: 'if none opens,', opts: CONTINUE_OR_STOP, adv: true }] },
  click: { cat: 'Menus', icon: 'mouse', label: 'Click in the menu on', def: { match: '', slot: null, button: 'left', shift: false, wait: 5, onFail: 'continue' }, help: 'Clicks an item in the open menu, found by its name (or description). Waits a moment for the menu to open.', fields: [{ k: 'match', t: 'text', w: 'm', ph: 'item name, e.g. Confirm' }, { k: 'slot', t: 'num', pre: 'or slot #', ph: '–', min: 0, max: 199, opt: true, adv: true }, { k: 'button', t: 'sel', opts: [['left', 'left click'], ['right', 'right click']], adv: true }, { k: 'shift', t: 'bool', label: 'Shift', adv: true }, { k: 'wait', t: 'num', pre: 'wait up to', post: 's for the menu', min: 0, max: 120, adv: true }, { k: 'onFail', t: 'sel', pre: 'if not found,', opts: CONTINUE_OR_STOP, adv: true }] },
  closeMenu: { cat: 'Menus', icon: 'close', label: 'Close the menu', def: {}, fields: [] },
  use: { cat: 'Actions', icon: 'mouse', label: 'Right click', def: { hold: 0 }, help: 'Uses what it holds, or the block or entity it looks at (doors, NPCs, a compass...). Hold it down to eat, drink or draw a bow.', fields: [{ k: 'hold', t: 'num', pre: 'and hold for', post: 's', min: 0, max: 30, step: 0.1 }] },
  attack: { cat: 'Actions', icon: 'bolt', label: 'Attack', def: { target: 'crosshair', name: '', range: 4 }, fields: [{ k: 'target', t: 'sel', re: true, opts: [['crosshair', 'what it\'s looking at'], ['hostile', 'the nearest hostile mob'], ['mob', 'the nearest mob'], ['player', 'the nearest player'], ['name', 'the nearest one named']] }, { k: 'name', t: 'text', w: 's', ph: 'name', when: (s) => s.target === 'name' }, { k: 'range', t: 'num', pre: 'within', post: 'blocks', min: 1, max: 6, step: 0.5 }] },
  fish: { cat: 'Actions', icon: 'refresh', label: 'Fish once', def: { timeout: 60 }, help: 'Casts, waits for a bite and reels in. Needs a fishing rod (it takes one from the inventory).', fields: [{ k: 'timeout', t: 'num', pre: 'give up after', post: 's', min: 5, max: 600 }] },
  respawn: { cat: 'Actions', icon: 'heart', label: 'Respawn (if dead)', def: {}, fields: [] },
  hotbar: { cat: 'Items', icon: 'box', label: 'Select hotbar slot', def: { slot: 1 }, fields: [{ k: 'slot', t: 'num', min: 1, max: 9 }] },
  equip: { cat: 'Items', icon: 'box', label: 'Hold', def: { item: '' }, help: 'Puts an item from the inventory in its hand, found by name.', fields: [{ k: 'item', t: 'text', w: 'm', ph: 'item, e.g. diamond sword' }] },
  eat: { cat: 'Items', icon: 'food', label: 'Eat', def: { below: 18 }, help: 'Eats the best food in the inventory.', fields: [{ k: 'below', t: 'num', pre: 'if hunger is below', post: '/ 20', min: 1, max: 20 }] },
  drop: { cat: 'Items', icon: 'down', label: 'Drop', def: { item: '', all: false }, fields: [{ k: 'item', t: 'text', w: 'm', ph: 'item (empty = what it holds)' }, { k: 'all', t: 'bool', label: 'every stack' }] },
  look: { cat: 'Movement', icon: 'eye', label: 'Look', def: { mode: 'direction', dir: 'north', pitch: 0, turn: 90, target: 'player', x: 0, y: 64, z: 0 }, fields: [{ k: 'mode', t: 'sel', re: true, opts: [['direction', 'towards'], ['turn', 'turn right by'], ['nearest', 'at the nearest'], ['position', 'at']] }, { k: 'dir', t: 'sel', opts: [['north', 'north'], ['east', 'east'], ['south', 'south'], ['west', 'west']], when: (s) => s.mode === 'direction' }, { k: 'pitch', t: 'num', pre: 'angle', post: '° (−90 down, 90 up)', min: -90, max: 90, when: (s) => s.mode === 'direction' }, { k: 'turn', t: 'num', post: '° (negative = left)', min: -360, max: 360, when: (s) => s.mode === 'turn' }, { k: 'target', t: 'sel', opts: [['player', 'player'], ['mob', 'mob'], ['hostile', 'hostile mob']], when: (s) => s.mode === 'nearest' }, { k: 'x', t: 'num', pre: 'X', when: (s) => s.mode === 'position' }, { k: 'y', t: 'num', pre: 'Y', when: (s) => s.mode === 'position' }, { k: 'z', t: 'num', pre: 'Z', when: (s) => s.mode === 'position' }] },
  move: { cat: 'Movement', icon: 'play', label: 'Walk', def: { dir: 'forward', sec: 1, sprint: false, jump: false }, fields: [{ k: 'dir', t: 'sel', opts: [['forward', 'forward'], ['back', 'backward'], ['left', 'left'], ['right', 'right']] }, { k: 'sec', t: 'num', pre: 'for', post: 's', min: 0.05, step: 0.1 }, { k: 'sprint', t: 'bool', label: 'sprint' }, { k: 'jump', t: 'bool', label: 'jump' }] },
  goto: { cat: 'Movement', icon: 'pin', label: 'Walk to', def: { x: 0, z: 0, timeout: 30, sprint: false }, help: 'Walks in a straight line and jumps up single blocks. It doesn\'t find its way around walls.', fields: [{ k: 'x', t: 'num', pre: 'X' }, { k: 'z', t: 'num', pre: 'Z' }, { k: 'sprint', t: 'bool', label: 'sprint' }, { k: 'timeout', t: 'num', pre: 'give up after', post: 's', min: 1, adv: true }] },
  control: { cat: 'Movement', icon: 'up', label: '', def: { action: 'jump' }, fields: [{ k: 'action', t: 'sel', opts: [['jump', 'Jump'], ['sneakOn', 'Start sneaking'], ['sneakOff', 'Stop sneaking'], ['sprintOn', 'Start sprinting'], ['sprintOff', 'Stop sprinting']] }] },
  repeat: { cat: 'Flow', icon: 'repeat', label: 'Repeat', block: true, def: { times: 5 }, help: 'Repeats the steps up to its End. {i} is the round number.', fields: [{ k: 'times', t: 'num', min: 0, post: 'times (0 = forever)' }] },
  if: { cat: 'Flow', icon: 'branch', label: '', block: true, def: { cond: 'health', not: false, value: 10, item: '', count: 1, match: '', within: 10, left: '', op: 'equals', right: '' }, help: 'Runs the steps up to Otherwise/End only if this is true.', fields: [{ k: 'not', t: 'sel', bool: true, opts: [[false, 'If'], [true, 'If NOT']] }, { k: 'cond', t: 'sel', re: true, opts: [['health', 'health is below'], ['food', 'hunger is below'], ['item', 'it has at least'], ['menu', 'a menu is open'], ['chat', 'chat said'], ['chance', 'a random chance of'], ['text', 'the text']] }, { k: 'value', t: 'num', min: 0, max: 100, post: per, when: (s) => ['health', 'food', 'chance'].includes(s.cond) }, { k: 'count', t: 'num', min: 1, when: (s) => s.cond === 'item' }, { k: 'item', t: 'text', w: 'm', ph: 'item name', when: (s) => s.cond === 'item' }, { k: 'match', t: 'text', w: 'm', ph: (s) => (s.cond === 'menu' ? 'title contains (optional)' : 'text, * = anything'), when: (s) => s.cond === 'menu' || s.cond === 'chat' }, { k: 'within', t: 'num', pre: 'in the last', post: 's', min: 1, when: (s) => s.cond === 'chat' }, { k: 'left', t: 'text', w: 'm', ph: '{1}', when: (s) => s.cond === 'text' }, { k: 'op', t: 'sel', opts: [['equals', 'is'], ['contains', 'contains']], when: (s) => s.cond === 'text' }, { k: 'right', t: 'text', w: 'm', ph: 'text', when: (s) => s.cond === 'text' }] },
  else: { icon: 'branch', label: 'Otherwise', def: {}, fields: [] },
  end: { icon: 'up', label: 'End', def: {}, fields: [] },
  set: { cat: 'Flow', icon: 'edit', label: 'Set', def: { name: 'value', value: '' }, help: 'Remembers some text as {name} for later steps.', fields: [{ k: 'name', t: 'text', w: 's', ph: 'name' }, { k: 'value', t: 'text', pre: 'to', w: 'l', ph: 'text, {1}, {random:1-10}…' }] },
  run: { cat: 'Flow', icon: 'play', label: 'Run macro', def: { macro: '' }, help: 'Runs another macro\'s steps here, then carries on.', fields: [{ k: 'macro', t: 'macro' }] },
  log: { cat: 'Flow', icon: 'alert', label: 'Note', def: { text: '', notify: false }, help: 'Writes a line in the chat window (only you see it).', fields: [{ k: 'text', t: 'text', w: 'grow', ph: 'e.g. Sold everything at {time}' }, { k: 'notify', t: 'bool', label: 'pop-up + taskbar flash' }] },
  stop: { cat: 'Flow', icon: 'stop', label: 'Stop the macro', def: {}, fields: [] },
  disconnect: { cat: 'Flow', icon: 'stop', label: 'Disconnect the account', def: {}, fields: [] }
}

const TRIGGER_UI = {
  manual: { label: 'Only when I run it', fields: [] },
  join: { label: 'When the account joins', fields: [{ k: 'delay', t: 'num', pre: 'after', post: 'seconds', min: 0, max: 600 }] },
  chat: { label: 'When chat says…', fields: [{ k: 'match', t: 'text', w: 'l', ph: 'e.g. * has requested to teleport to you' }, { k: 'cooldown', t: 'num', pre: 'at most once every', post: 's', min: 0, adv: true }] },
  interval: { label: 'Every few minutes', fields: [{ k: 'every', t: 'num', pre: 'every', post: 'minutes', min: 0.05, step: 0.5 }, { k: 'jitter', t: 'num', pre: '±', post: '% random', min: 0, max: 90, adv: true }] },
  menu: { label: 'When a menu opens', fields: [{ k: 'match', t: 'text', w: 'm', ph: 'title contains (optional)' }, { k: 'cooldown', t: 'num', pre: 'at most once every', post: 's', min: 0, adv: true }] },
  death: { label: 'When the account dies', fields: [{ k: 'cooldown', t: 'num', pre: 'at most once every', post: 's', min: 0, adv: true }] },
  health: { label: 'When health gets low', fields: [{ k: 'below', t: 'num', pre: 'below', post: '/ 20', min: 1, max: 20 }, { k: 'cooldown', t: 'num', pre: 'at most once every', post: 's', min: 0, adv: true }] }
}

function triggerSummary (m) {
  const t = m.trigger
  const auto = m.enabled ? '' : ' (off)'
  switch (t.type) {
    case 'join': return `When it joins${auto}`
    case 'chat': return `On chat "${t.match || '…'}"${auto}`
    case 'interval': return `Every ${t.every} min${auto}`
    case 'menu': return `When a menu opens${auto}`
    case 'death': return `When it dies${auto}`
    case 'health': return `Health below ${t.below}${auto}`
    default: return m.hotkey ? `Run by hand · ${m.hotkey}` : 'Run by hand'
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x))

export class MacroView {
  /**
   * @param {HTMLElement} root
   * @param {object} o
   * @param {() => object} o.state  the app state (accounts, slots)
   * @param {(text: string, opts?: object) => void} o.toast
   * @param {() => string[]} o.selectedAccounts  accounts ticked in the sidebar
   */
  constructor (root, { state, toast, selectedAccounts }) {
    this.root = root
    this.state = state
    this.toast = toast
    this.selectedAccounts = selectedAccounts
    this.macros = []
    this.runs = []
    this.log = []
    this.templates = []
    this.encrypted = true
    this.selectedId = null
    this.draft = null
    this.loaded = false
  }

  async load () {
    const s = await api.call('getMacros')
    this.macros = s.macros
    this.runs = s.runs
    this.log = s.log
    this.templates = s.templates
    this.encrypted = s.encrypted
    this.loaded = true
    if (!this.selectedId && this.macros.length) this.select(this.macros[0].id, false)
    this.render()
  }

  show () { if (!this.loaded) this.load(); else this.render() }

  // ------------------------------------------------------------------ events from the main process
  onMacros (list) {
    this.macros = list
    const m = list.find(x => x.id === this.selectedId)
    if (!m) { this.selectedId = null; this.draft = null } else if (this.draft && m.enabled !== this.draft.enabled) {
      this.draft.enabled = m.enabled // switched off by MineDeck (runaway protection)
      const t = this.root.querySelector('#macro-enabled')
      if (t) t.checked = m.enabled
    }
    this.renderList()
    if (!this.draft) this.renderEditor()
  }

  onRuns (runs) {
    this.runs = runs
    this.renderList()
    this.renderActivity()
    this.markRunningSteps()
  }

  onLog (entry) {
    this.log.push(entry)
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300)
    if (entry.macroId === this.selectedId) this.renderActivity()
  }

  // ------------------------------------------------------------------ layout
  render () {
    if (!this.loaded) return
    if (!this.root.firstChild) {
      this.listEl = h('div', { class: 'macro-items', role: 'list' })
      this.runningEl = h('div', { class: 'macro-running' })
      this.editorEl = h('section', { class: 'macro-editor' })
      this.root.append(
        h('aside', { class: 'macro-list' },
          h('div', { class: 'macro-list-head' },
            h('div', { class: 'macro-list-title' },
              h('div', { class: 'side-title', text: 'Macros' }),
              h('button', { class: 'btn small ghost', title: 'Add a macro someone shared with you', onclick: () => this.importDialog() }, icon('down', 12), 'Import')),
            h('div', { class: 'macro-list-actions' },
              h('button', { class: 'btn primary small', id: 'macro-new', onclick: () => this.create() }, icon('plus', 13), 'New macro'),
              h('button', { class: 'btn small', id: 'macro-templates', onclick: () => this.templatesDialog() }, icon('box', 13), 'Templates'))),
          this.listEl,
          this.runningEl),
        this.editorEl)
    }
    this.renderList()
    this.renderEditor()
  }

  renderList () {
    if (!this.listEl) return
    clear(this.listEl)
    for (const m of this.macros) {
      const running = this.runs.filter(r => r.macroId === m.id).length
      const row = h('div', { class: `macro-item${m.id === this.selectedId ? ' active' : ''}`, role: 'listitem', tabindex: '0', onclick: () => this.select(m.id), onkeydown: (e) => { if (e.key === 'Enter') this.select(m.id) } },
        h('div', { class: 'macro-item-text' },
          h('div', { class: 'macro-item-name', text: m.name }),
          h('div', { class: 'macro-item-sub' }, running ? h('span', { class: 'run-dot' }) : null, running ? `Running on ${running} · ` : '', triggerSummary(m))),
        running
          ? h('button', { class: 'icon-btn small', title: 'Stop', 'aria-label': `Stop ${m.name}`, onclick: (e) => { e.stopPropagation(); this.stop(m.id) } }, icon('stop', 13))
          : h('button', { class: 'icon-btn small go', title: 'Run now', 'aria-label': `Run ${m.name}`, onclick: (e) => { e.stopPropagation(); this.run(m.id) } }, icon('play', 13)))
      this.listEl.appendChild(row)
    }
    if (!this.macros.length) this.listEl.appendChild(h('p', { class: 'muted macro-list-empty', text: 'No macros yet.' }))
    clear(this.runningEl)
    if (this.runs.length) {
      this.runningEl.append(h('span', {}, h('span', { class: 'run-dot' }), `${this.runs.length} running`),
        h('button', { class: 'btn small ghost', onclick: () => this.stop(null) }, icon('stop', 11), 'Stop all'))
    }
  }

  select (id, render = true) {
    this.flushSave()
    this.selectedId = id
    const m = this.macros.find(x => x.id === id)
    this.draft = m ? clone(m) : null
    if (render) { this.renderList(); this.renderEditor() }
  }

  // ------------------------------------------------------------------ editor
  renderEditor () {
    const el = this.editorEl
    if (!el) return
    clear(el)
    const d = this.draft
    if (!d) {
      el.appendChild(h('div', { class: 'macro-empty' },
        icon('bolt', 30),
        h('h3', { text: 'Let your accounts do things by themselves' }),
        h('p', { class: 'muted', text: 'A macro is a list of steps: say something, wait, click in a menu, walk, fight, fish, eat... It can run when you press a button or a hotkey, or start by itself when an account joins, when chat says something, every few minutes, when a menu opens or when health gets low.' }),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary', onclick: () => this.templatesDialog() }, icon('box', 14), 'Start from a template'),
          h('button', { class: 'btn', onclick: () => this.create() }, icon('plus', 14), 'Blank macro'))))
      return
    }
    const running = this.runs.some(r => r.macroId === d.id)
    // header: name and actions
    const name = h('input', { class: 'input macro-name', value: d.name, maxlength: 60, 'aria-label': 'Macro name', oninput: (e) => { d.name = e.target.value; this.queueSave() } })
    el.appendChild(h('div', { class: 'macro-head' }, name,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', id: 'macro-run', title: 'Run on its accounts (online ones)', onclick: () => this.run(d.id) }, icon('play', 12), 'Run'),
        h('button', { class: 'btn', title: 'Run on the accounts ticked on the left', onclick: () => this.run(d.id, this.selectedAccounts()) }, 'Run on ticked'),
        running ? h('button', { class: 'btn ghost', onclick: () => this.stop(d.id) }, icon('stop', 12), 'Stop') : null,
        h('button', { class: 'icon-btn', title: 'Duplicate', 'aria-label': 'Duplicate', onclick: () => this.duplicate() }, icon('copy', 15)),
        h('button', { class: 'icon-btn', title: 'Share (copies it as text)', 'aria-label': 'Share', onclick: () => this.share() }, icon('send', 15)),
        h('button', { class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', onclick: () => this.remove() }, icon('trash', 15)))))
    if (!this.encrypted) el.appendChild(h('div', { class: 'macro-warn' }, icon('alert', 13), 'This PC has no secure key storage, so macros are saved unencrypted. Don\'t put passwords in them.'))

    el.append(this.triggerCard(), this.accountsCard(), this.stepsCard(), this.optionsCard(), this.activityCard())
    this.markRunningSteps()
  }

  card (title, sub, ...children) {
    return h('div', { class: 'macro-card' }, h('div', { class: 'macro-card-head' }, h('b', { text: title }), sub ? h('span', { class: 'muted', text: sub }) : null), ...children)
  }

  triggerCard () {
    const d = this.draft
    const body = h('div', { class: 'macro-trigger' })
    const draw = () => {
      clear(body)
      const t = d.trigger
      const typeSel = h('select', { class: 'input slim', id: 'macro-trigger', onchange: (e) => { t.type = e.target.value; if (t.type !== 'manual' && !d.enabled) d.enabled = true; this.queueSave(); draw() } },
        Object.entries(TRIGGER_UI).map(([k, v]) => h('option', { value: k, text: v.label })))
      typeSel.value = t.type
      const line = h('div', { class: 'fline' }, h('span', { class: 'word', text: 'Starts' }), typeSel)
      const adv = h('div', { class: 'fline adv' })
      for (const f of TRIGGER_UI[t.type].fields) (f.adv ? adv : line).append(...this.field(f, t, () => this.queueSave()))
      body.appendChild(line)
      if (adv.childNodes.length) body.appendChild(adv)
      if (t.type !== 'manual') {
        const toggle = h('input', { type: 'checkbox', class: 'switch', id: 'macro-enabled', checked: d.enabled, onchange: (e) => { d.enabled = e.target.checked; this.queueSave(); this.renderList() } })
        body.appendChild(h('label', { class: 'switch-row' }, toggle, h('span', { text: 'Start by itself (switch off to pause it)' })))
      }
      if (t.type === 'chat' || t.type === 'menu') body.appendChild(h('p', { class: 'hint', text: '* stands for any text and is saved as {1}, {2}… for the steps. {account} is the account\'s name.' }))
      if (t.type === 'interval') body.appendChild(h('p', { class: 'hint', text: 'The first run is a few seconds after each account comes online.' }))
      const hotkey = h('select', { class: 'input slim w-key', 'aria-label': 'Hotkey', onchange: (e) => { d.hotkey = e.target.value; this.queueSave(); this.renderList() } },
        h('option', { value: '', text: 'none' }), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map(k => h('option', { value: k, text: k })))
      hotkey.value = d.hotkey
      body.appendChild(h('div', { class: 'fline adv' }, h('span', { class: 'word', text: 'Hotkey in MineDeck:' }), hotkey, h('span', { class: 'word', text: 'runs it on its accounts' })))
    }
    draw()
    return this.card('When it runs', null, body)
  }

  accountsCard () {
    const d = this.draft
    const body = h('div', { class: 'macro-accounts' })
    const draw = () => {
      clear(body)
      const all = d.accounts === 'all'
      const radio = (value, label) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: 'macro-acc', checked: (value === 'all') === all, onchange: () => { d.accounts = value === 'all' ? 'all' : this.state().accounts.map(a => a.id).filter(id => this.selectedAccounts().includes(id)); this.queueSave(); draw() } }),
        h('span', { text: label }))
      body.append(radio('all', 'All online accounts'), radio('some', 'Only these:'))
      if (!all) {
        const chips = h('div', { class: 'acc-chips' })
        for (const a of this.state().accounts) {
          const on = d.accounts.includes(a.id)
          chips.appendChild(h('label', { class: `chip pick${on ? ' on' : ''}` },
            h('input', { type: 'checkbox', checked: on, onchange: (e) => { d.accounts = e.target.checked ? [...d.accounts, a.id] : d.accounts.filter(x => x !== a.id); this.queueSave(); draw() } }),
            h('span', { text: a.name }), h('span', { class: `dot ${this.state().slots[a.id]?.status === 'online' ? 'on' : 'off'}` })))
        }
        body.appendChild(chips)
      }
    }
    draw()
    return this.card('Accounts', 'which accounts it runs on (only online ones run)', body)
  }

  // ------------------------------------------------------------------ steps
  stepsCard () {
    this.stepsEl = h('div', { class: 'macro-steps', role: 'list' })
    this.renderSteps()
    const add = h('button', { class: 'btn small', id: 'macro-add-step', onclick: (e) => this.addStepMenu(e.currentTarget, this.draft.steps.length) }, icon('plus', 12), 'Add step')
    return this.card('Steps', 'run from top to bottom', this.stepsEl, h('div', { class: 'macro-steps-foot' }, add,
      h('span', { class: 'hint', text: 'In any text: {account} {server} {x} {y} {z} {health} {food} {time} {date} {random:1-10} {i} (round of a Repeat), and {1} {2}… from * in chat patterns.' })))
  }

  renderSteps () {
    const el = this.stepsEl
    if (!el) return
    clear(el)
    const steps = this.draft.steps
    if (!steps.length) {
      el.appendChild(h('div', { class: 'macro-steps-empty muted', text: 'No steps yet. Add one below, or start from a template.' }))
      return
    }
    let depth = 0
    const openers = []
    steps.forEach((s, i) => {
      if (s.type === 'end' || s.type === 'else') depth = Math.max(0, depth - 1)
      el.appendChild(this.stepRow(s, i, depth, s.type === 'end' ? steps[openers[openers.length - 1]]?.type : null))
      if (s.type === 'repeat' || s.type === 'if') { depth++; openers.push(i) }
      if (s.type === 'else') depth++
      if (s.type === 'end') openers.pop()
    })
  }

  stepRow (s, i, depth, closes) {
    const ui = STEP_UI[s.type]
    const row = h('div', { class: `mstep kind-${s.type}${ui.block ? ' block' : ''}`, role: 'listitem', dataset: { index: String(i) }, style: { '--depth': String(depth) } })
    const line = h('div', { class: 'fline' })
    const adv = h('div', { class: 'fline adv' })
    let label = ui.label
    if (s.type === 'end') label = closes === 'repeat' ? 'End of repeat' : closes === 'if' ? 'End of if' : 'End'
    if (label) line.appendChild(h('span', { class: 'word strong', text: label }))
    const redraw = () => { const fresh = this.stepRow(s, i, depth, closes); row.replaceWith(fresh) }
    for (const f of ui.fields) {
      if (f.when && !f.when(s)) continue
      ;(f.adv ? adv : line).append(...this.field(f, s, () => { this.queueSave(); if (f.re) redraw() }))
    }
    const body = h('div', { class: 'mstep-body' }, line)
    if (adv.childNodes.length) body.appendChild(adv)
    if (ui.help && !['end', 'else'].includes(s.type)) row.title = ui.help
    const structural = s.type === 'end' || s.type === 'else'
    row.append(
      h('span', { class: 'mstep-n', text: String(i + 1) }),
      h('span', { class: 'mstep-icon' }, icon(ui.icon, 14)),
      body,
      h('span', { class: 'mstep-runners' }),
      h('div', { class: 'mstep-tools' },
        h('button', { class: 'icon-btn small', title: 'Add a step below', 'aria-label': 'Add a step below', onclick: (e) => this.addStepMenu(e.currentTarget, i + 1) }, icon('plus', 12)),
        structural ? null : h('button', { class: 'icon-btn small', title: 'Move up', 'aria-label': 'Move up', onclick: () => this.moveStep(i, -1) }, icon('up', 12)),
        structural ? null : h('button', { class: 'icon-btn small', title: 'Move down', 'aria-label': 'Move down', onclick: () => this.moveStep(i, 1) }, icon('down', 12)),
        structural ? null : h('button', { class: 'icon-btn small', title: 'Duplicate', 'aria-label': 'Duplicate step', onclick: () => this.duplicateStep(i) }, icon('copy', 12)),
        s.type === 'end' ? null : h('button', { class: 'icon-btn small danger', title: ui.block ? 'Delete (with its End)' : 'Delete', 'aria-label': 'Delete step', onclick: () => this.deleteStep(i) }, icon('trash', 12))))
    return row
  }

  /** inputs for one field of a step (or the trigger); returns [elements] */
  field (f, obj, onChange) {
    const out = []
    const pre = typeof f.pre === 'function' ? f.pre(obj) : f.pre
    const post = typeof f.post === 'function' ? f.post(obj) : f.post
    if (pre) out.push(h('span', { class: 'word', text: pre }))
    let input = null
    if (f.t === 'text') {
      input = h('input', { class: `input slim w-${f.w || 'm'}`, value: obj[f.k] ?? '', placeholder: typeof f.ph === 'function' ? f.ph(obj) : (f.ph || ''), maxlength: 256, spellcheck: 'false', oninput: (e) => { obj[f.k] = e.target.value; onChange() } })
    } else if (f.t === 'num') {
      input = h('input', { class: 'input slim w-num', type: 'number', value: obj[f.k] ?? '', placeholder: f.ph || '', min: f.min, max: f.max, step: f.step || 1,
        oninput: (e) => {
          const v = e.target.value.trim()
          if (v === '' && f.opt) obj[f.k] = null
          else if (v !== '' && Number.isFinite(Number(v))) obj[f.k] = Number(v)
          else return
          onChange()
        } })
    } else if (f.t === 'sel') {
      input = h('select', { class: 'input slim', onchange: (e) => { obj[f.k] = f.bool ? e.target.value === 'true' : e.target.value; onChange() } },
        f.opts.map(([v, label]) => h('option', { value: String(v), text: label })))
      input.value = String(obj[f.k])
    } else if (f.t === 'bool') {
      out.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[f.k], onchange: (e) => { obj[f.k] = e.target.checked; onChange() } }), h('span', { text: f.label })))
    } else if (f.t === 'macro') {
      input = h('select', { class: 'input slim', onchange: (e) => { obj[f.k] = e.target.value; onChange() } },
        h('option', { value: '', text: 'choose a macro…' }),
        this.macros.filter(m => m.id !== this.draft.id).map(m => h('option', { value: m.id, text: m.name })))
      input.value = obj[f.k] || ''
    }
    if (input) out.push(input)
    if (post) out.push(h('span', { class: 'word', text: post }))
    return out
  }

  addStepMenu (anchor, at) {
    const menu = h('div', { class: 'popover step-menu', role: 'menu' })
    for (const cat of CATEGORIES) {
      const types = Object.entries(STEP_UI).filter(([, u]) => u.cat === cat)
      menu.appendChild(h('div', { class: 'step-menu-cat', text: cat }))
      const grid = h('div', { class: 'step-menu-grid' })
      for (const [type, u] of types) {
        const label = type === 'control' ? 'Jump, sneak, sprint' : type === 'if' ? 'If…' : u.label
        grid.appendChild(h('button', { class: 'pop-item', role: 'menuitem', title: u.help || '', onclick: () => { close(); this.insertStep(type, at) } }, h('span', { class: 'pop-icon' }, icon(u.icon, 13)), label))
      }
      menu.appendChild(grid)
    }
    document.body.appendChild(menu)
    const r = anchor.getBoundingClientRect()
    const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)
    menu.style.top = `${Math.max(8, top)}px`
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`
    const onDoc = (e) => { if (!menu.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    function close () { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true) }
    setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true) }, 0)
  }

  insertStep (type, at) {
    const steps = this.draft.steps
    const fresh = { type, ...clone(STEP_UI[type].def) }
    if (STEP_UI[type].block) steps.splice(at, 0, fresh, { type: 'end' })
    else steps.splice(at, 0, fresh)
    this.renderSteps()
    this.queueSave()
    const row = this.stepsEl.querySelector(`[data-index="${at}"]`)
    if (row) {
      row.scrollIntoView({ block: 'nearest' })
      const input = row.querySelector('input, select')
      if (input) input.focus()
    }
  }

  // the steps that belong to step i: just it, or a whole Repeat/If block up to its End
  span (i) {
    const steps = this.draft.steps
    if (!STEP_UI[steps[i].type].block) return [i, i]
    let depth = 0
    for (let j = i; j < steps.length; j++) {
      if (steps[j].type === 'repeat' || steps[j].type === 'if') depth++
      if (steps[j].type === 'end' && --depth === 0) return [i, j]
    }
    return [i, steps.length - 1]
  }

  moveStep (i, dir) {
    const steps = this.draft.steps
    const [a, b] = this.span(i)
    const block = steps.slice(a, b + 1)
    if (dir < 0) {
      if (a === 0) return
      steps.splice(a, block.length)
      steps.splice(a - 1, 0, ...block)
    } else {
      if (b >= steps.length - 1) return
      steps.splice(a, block.length)
      steps.splice(a + 1, 0, ...block)
    }
    this.renderSteps()
    this.queueSave()
  }

  duplicateStep (i) {
    const [a, b] = this.span(i)
    this.draft.steps.splice(b + 1, 0, ...clone(this.draft.steps.slice(a, b + 1)))
    this.renderSteps()
    this.queueSave()
  }

  deleteStep (i) {
    const steps = this.draft.steps
    if (steps[i].type === 'else') steps.splice(i, 1)
    else { const [a, b] = this.span(i); steps.splice(a, b - a + 1) }
    this.renderSteps()
    this.queueSave()
  }

  markRunningSteps () {
    if (!this.stepsEl || !this.draft) return
    for (const el of this.stepsEl.querySelectorAll('.mstep.current')) el.classList.remove('current')
    for (const el of this.stepsEl.querySelectorAll('.mstep-runners')) clear(el)
    const names = new Map(this.state().accounts.map(a => [a.id, a.name]))
    const byStep = new Map()
    for (const r of this.runs) {
      if (r.macroId !== this.draft.id || r.step < 0) continue
      if (!byStep.has(r.step)) byStep.set(r.step, [])
      byStep.get(r.step).push(names.get(r.accountId) || '?')
    }
    for (const [step, who] of byStep) {
      const row = this.stepsEl.querySelector(`[data-index="${step}"]`)
      if (!row) continue
      row.classList.add('current')
      row.querySelector('.mstep-runners').textContent = who.length > 2 ? `${who.slice(0, 2).join(', ')} +${who.length - 2}` : who.join(', ')
    }
  }

  // ------------------------------------------------------------------ options and activity
  optionsCard () {
    const d = this.draft
    const loop = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.loop, onchange: (e) => { d.loop = e.target.checked; this.queueSave() } }), h('span', { text: 'When it finishes, start again after' }))
    return this.card('Options', null,
      h('div', { class: 'fline' }, loop, ...this.field({ k: 'loopDelay', t: 'num', post: 'seconds', min: 0, step: 0.5 }, d, () => this.queueSave())),
      h('div', { class: 'fline' }, ...this.field({ k: 'stagger', t: 'num', pre: 'When several accounts start it together, start them', post: 'seconds apart', min: 0, step: 0.5 }, d, () => this.queueSave())),
      h('div', { class: 'fline' }, ...this.field({ k: 'onReconnect', t: 'sel', pre: 'If the account disconnects while it runs,', opts: [['stop', 'stop it'], ['restart', 'start it again after reconnecting']] }, d, () => this.queueSave())),
      h('div', { class: 'fline' }, h('span', { class: 'word', text: 'Notes' }), h('input', { class: 'input slim w-grow', value: d.notes || '', maxlength: 500, placeholder: 'What it\'s for (optional)', oninput: (e) => { d.notes = e.target.value; this.queueSave() } })))
  }

  activityCard () {
    this.activityEl = h('div', { class: 'macro-activity' })
    this.renderActivity()
    return this.card('Activity', null, this.activityEl)
  }

  renderActivity () {
    const el = this.activityEl
    if (!el || !this.draft) return
    clear(el)
    const names = new Map(this.state().accounts.map(a => [a.id, a.name]))
    const runs = this.runs.filter(r => r.macroId === this.draft.id)
    for (const r of runs) {
      el.appendChild(h('div', { class: 'act-run' },
        h('span', { class: 'run-dot' }),
        h('b', { text: names.get(r.accountId) || '?' }),
        h('span', { class: 'muted', text: `step ${r.step + 1} · ${r.status}${r.iteration > 1 ? ` · round ${r.iteration}` : ''}` }),
        h('button', { class: 'btn small ghost', onclick: () => api.call('stopMacro', this.draft.id, r.accountId) }, icon('stop', 10), 'Stop')))
    }
    const lines = this.log.filter(l => l.macroId === this.draft.id).slice(-30)
    if (runs.length) el.appendChild(h('p', { class: 'hint', text: 'Changes you make now apply the next time it starts.' }))
    if (!runs.length && !lines.length) el.appendChild(h('p', { class: 'muted', text: 'Not running. Press Run, or let its trigger start it.' }))
    for (const l of lines.reverse()) {
      el.appendChild(h('div', { class: `act-line lvl-${l.level}` }, h('span', { class: 'ts', text: clock(l.time) }), h('b', { text: l.name }), h('span', { text: l.text })))
    }
  }

  // ------------------------------------------------------------------ saving and actions
  // MineDeck also sends the updated list as soon as a macro is saved, which can arrive
  // before the reply to the save itself: add it only if it isn't in the list yet
  upsert (m) {
    const i = this.macros.findIndex(x => x.id === m.id)
    if (i >= 0) this.macros[i] = m
    else this.macros.push(m)
  }

  queueSave () {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flushSave(), 450)
  }

  flushSave () {
    if (!this.saveTimer || !this.draft) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    const sent = clone(this.draft)
    return api.call('saveMacro', sent).then((saved) => {
      const i = this.macros.findIndex(m => m.id === saved.id)
      if (i >= 0) this.macros[i] = saved
      if (this.draft && this.draft.id === saved.id && JSON.stringify(saved.steps.map(s => s.type)) !== JSON.stringify(this.draft.steps.map(s => s.type))) {
        this.draft.steps = saved.steps // MineDeck fixed the structure (a missing End...)
        this.renderSteps()
      }
      this.renderList()
    }).catch((e) => this.toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { kind: 'error' }))
  }

  async create () {
    await this.flushSave()
    const m = await api.call('saveMacro', { name: 'New macro', steps: [] })
    this.upsert(m)
    this.select(m.id)
    const name = this.root.querySelector('.macro-name')
    if (name) { name.focus(); name.select() }
  }

  async duplicate () {
    await this.flushSave()
    const copy = clone(this.draft)
    delete copy.id
    const m = await api.call('saveMacro', { ...copy, name: `${copy.name} (copy)`.slice(0, 60), enabled: false })
    this.upsert(m)
    this.select(m.id)
  }

  async remove () {
    const d = this.draft
    const ok = await confirmDialog({ title: `Delete "${d.name}"?`, message: 'It stops wherever it is running and is deleted from this PC.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    await api.call('deleteMacro', d.id)
    this.macros = this.macros.filter(m => m.id !== d.id)
    this.select(this.macros[0]?.id || null)
  }

  async share () {
    await this.flushSave()
    await api.call('shareMacro', this.draft.id)
    this.toast('Copied. Paste that text to a friend: they can add it with Import (↓) in their Macros tab.')
  }

  async run (id, accountIds = null) {
    await this.flushSave()
    try {
      if (accountIds && !accountIds.length) { this.toast('Tick some accounts on the left first.', { kind: 'warn' }); return }
      const r = await api.call('runMacro', id, accountIds)
      if (!r.online) this.toast('None of its accounts are online.', { kind: 'warn' })
      else if (!r.started) this.toast('It is already running on those accounts.')
    } catch (e) {
      this.toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { kind: 'error' })
    }
  }

  stop (id) {
    api.call('stopMacro', id, null)
  }

  /** an F-key was pressed: run the macros that use it */
  hotkey (key) {
    const list = this.macros.filter(m => m.hotkey === key)
    for (const m of list) this.run(m.id)
    if (list.length) this.toast(`${key}: running ${list.map(m => m.name).join(', ')}`)
    return list.length > 0
  }

  templatesDialog () {
    const body = h('div', { class: 'template-list' })
    let modal = null
    for (const t of this.templates) {
      body.appendChild(h('div', { class: 'template' },
        h('div', {}, h('b', { text: t.title }), h('p', { class: 'muted', text: t.description })),
        h('button', { class: 'btn small primary', onclick: async () => {
          const m = await api.call('addMacroTemplate', t.key)
          this.upsert(m)
          modal.close()
          this.select(m.id)
          if (m.trigger.type !== 'manual') this.toast('Added. Its automatic start is off: check the steps, then switch it on under "When it runs".')
        } }, icon('plus', 12), 'Add')))
    }
    modal = openModal({ title: 'Macro templates', subtitle: 'Ready-made macros to start from. You can change anything after adding one.', body, wide: true })
  }

  importDialog () {
    const area = h('textarea', { class: 'input mono', rows: 6, placeholder: 'MineDeck macro v1:{…}', spellcheck: 'false' })
    const error = h('div', { class: 'form-error', hidden: true })
    const modal = openModal({
      title: 'Import a macro',
      subtitle: 'Paste a macro someone shared with you. Macros can only do the steps you see in the editor: they can\'t read your files or sign-ins. Check what it does before running it.',
      body: h('div', {}, area, error),
      actions: [
        { label: 'Cancel', onClick: ({ close }) => close() },
        { label: 'Import', kind: 'primary', onClick: async ({ close }) => {
          try {
            const m = await api.call('importMacro', area.value)
            this.upsert(m)
            close()
            this.select(m.id)
            this.toast('Imported. Its automatic start is off until you switch it on.')
          } catch (e) {
            error.hidden = false
            error.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          }
        } }
      ]
    })
    return modal
  }
}
