// MineDeck window: account list, server picker, chat, composer, POV.
import { h, clear, append, duration, nameHue, store, debounce } from './ui.js'
import { icon } from './icons.js'
import { ChatView } from './chat.js'
import { PovView } from './pov.js'
import { MacroView } from './macros.js'
import { addAccountDialog, serverDialog, settingsDialog, privacyDialog, versionSelect, confirmDialog, cleanError, isModalOpen, openModal } from './modals.js'

const api = window.minedeck
const $ = (sel) => document.querySelector(sel)
// same list as src/main/secrets.js
const SECRET_COMMAND = /^(\/(?:login|log|l|register|reg|changepassword|changepass|cp|unregister|unreg|2fa|totp))(\s+)\S.*$/i

const STATUS = {
  offline: { label: 'Offline', tone: 'off' },
  queued: { label: 'Queued', tone: 'wait' },
  signing_in: { label: 'Signing in…', tone: 'busy' },
  connecting: { label: 'Connecting…', tone: 'busy' },
  logging_in: { label: 'Joining…', tone: 'busy' },
  online: { label: 'Online', tone: 'on' },
  waiting: { label: 'Reconnecting', tone: 'wait' },
  stopped: { label: 'Stopped', tone: 'err' },
  needs_sign_in: { label: 'Sign in again', tone: 'err' }
}

const app = {
  state: null,
  selected: new Set(store('selected') || []),
  filter: { view: 'all', search: '', selected: null },
  faces: new Map(),
  tab: 'chat',
  inputHistory: (store('inputHistory') || []).filter(t => typeof t === 'string' && !SECRET_COMMAND.test(t)),
  historyIndex: -1,
  chat: null,
  rows: new Map(),
  lastPing: null,

  toast,
  selectAccount (id, on) {
    if (on) this.selected.add(id)
    else this.selected.delete(id)
    saveSelection()
    renderAccounts()
    renderComposer()
    if (this.filter.view === 'selected') this.chat.rerender()
  },
  onSettings (settings) {
    const old = this.state.settings
    this.state.settings = settings
    const display = ['chatTimestamps', 'chatShowEvents', 'chatMergeDuplicates', 'chatMaxLines', 'highlightWords']
    if (display.some(k => JSON.stringify(old[k]) !== JSON.stringify(settings[k]))) this.chat.rerender()
    renderStatusbar()
  },
  onServerSaved (id, existing) {
    const online = onlineIds().filter(aid => app.state.slots[aid]?.serverId === id)
    if (existing && online.length) {
      toast(`Server updated. ${online.length} account${online.length === 1 ? ' is' : 's are'} still using the old settings.`, {
        action: { label: 'Reconnect them', onClick: () => api.call('reconnect', online) }
      })
    }
  }
}
app.filter.selected = app.selected

function saveSelection () {
  store('selected', [...app.selected])
}

function accountsById () {
  return new Map(app.state.accounts.map(a => [a.id, a]))
}

function onlineIds () {
  return app.state.accounts.filter(a => app.state.slots[a.id]?.status === 'online').map(a => a.id)
}

function currentServer () {
  return app.state.servers.find(s => s.id === app.state.selectedServerId) || null
}

// Is one of our accounts (or a highlight word) mentioned in the message body?
// The author part ("<Name> ", "[Rank] Name: ", "Name » ") is ignored, so our
// own messages echoed back by the server don't count.
function isMention (text) {
  const m = text.match(/^(.{0,48}?)(?:> |: | » | > )/)
  const body = (m ? text.slice(m[0].length) : text).toLowerCase()
  const words = [...app.state.accounts.map(a => a.name), ...(app.state.settings.highlightWords || [])]
  return words.some(w => w && w.length >= 3 && body.includes(w.toLowerCase()))
}

// ------------------------------------------------------------------ boot
async function boot () {
  app.state = await api.call('getState')
  // drop selections of accounts that no longer exist
  const ids = new Set(app.state.accounts.map(a => a.id))
  for (const id of [...app.selected]) if (!ids.has(id)) app.selected.delete(id)

  buildLayout()
  app.chat = new ChatView($('#chat-lines'), {
    getFilter: () => app.filter,
    getSettings: () => app.state.settings,
    isMention,
    onUnreadChange: (n) => {
      const b = $('#jump-latest')
      b.hidden = n === 0
      b.lastChild.textContent = n > 99 ? '99+ new' : `${n} new`
    },
    onClick: (k, accs, el) => chatClick(k, accs, el)
  })
  app.chat.setHistory(app.state.history || [])
  app.pov = new PovView($('#pov-panel'), {
    accounts: () => app.state.accounts,
    status: (id) => app.state.slots[id]?.status || 'offline',
    modalOpen: () => isModalOpen(),
    history: () => app.chat.lines,
    chatClick: (k, accs, el) => chatClick(k, accs, el)
  })
  $('#toolbar').appendChild(app.pov.tools)
  app.macros = new MacroView($('#macros-panel'), {
    state: () => app.state,
    toast,
    selectedAccounts: () => onlineIds().filter(id => app.selected.has(id))
  })
  app.macros.load().catch((e) => console.error('[macros]', e))
  renderAll()

  api.onEvent(({ type, payload }) => {
    switch (type) {
      case 'slots':
        app.state.slots = payload.slots
        app.state.queue = payload.queue
        renderAccounts()
        renderComposer()
        renderStatusbar()
        if (app.tab === 'players') renderPlayersPicker()
        if (app.tab === 'pov') app.pov.renderPicker()
        break
      case 'lines':
        app.chat.add(payload)
        app.pov.onLines(payload)
        break
      case 'pov':
        app.pov.onPov(payload)
        break
      case 'macros':
        app.macros.onMacros(payload)
        break
      case 'macroRuns':
        app.macros.onRuns(payload)
        break
      case 'macroLog':
        app.macros.onLog(payload)
        break
      case 'macroNotify':
        toast(payload.name ? `${payload.name} · ${payload.macro}: ${payload.text}` : `${payload.macro}: ${payload.text}`, { kind: payload.warn ? 'warn' : 'info', timeout: 10000 })
        break
      case 'menu': {
        // a server menu opened ("click to confirm" and the like): offer to answer it in POV
        if (app.tab === 'pov' && app.pov.id === payload.id) break
        const name = app.state.accounts.find(a => a.id === payload.id)?.name || 'An account'
        toast(`${name}: the server opened a menu ("${payload.title}")`, { action: { label: 'Open in POV', onClick: () => openPov(payload.id) } })
        break
      }
      case 'accounts': {
        app.state.accounts = payload
        const ids = new Set(payload.map(a => a.id))
        for (const id of [...app.selected]) if (!ids.has(id)) app.selected.delete(id)
        saveSelection()
        renderAccounts()
        renderComposer()
        renderViewFilter()
        renderOnboarding()
        if (app.tab === 'pov') app.pov.onAccounts()
        break
      }
      case 'servers':
        app.state.servers = payload.servers
        app.state.selectedServerId = payload.selectedServerId
        renderServerBar()
        renderOnboarding()
        break
      case 'settings':
        app.onSettings(payload)
        break
    }
  })

  setInterval(tick, 1000)
}

// ------------------------------------------------------------------ layout
function buildLayout () {
  const root = $('#app')
  clear(root)
  root.append(
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: 'logo.svg', alt: '', class: 'logo' }), h('span', { text: 'MineDeck' })),
      h('div', { class: 'server-bar', id: 'server-bar' }),
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn', id: 'privacy-btn', title: 'Privacy & data', 'aria-label': 'Privacy and data', onclick: () => privacyDialog(app) }, icon('shield', 18)),
        h('button', { class: 'icon-btn', id: 'settings-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => settingsDialog(app) }, icon('settings', 18)))),
    h('div', { class: 'banner', id: 'secure-banner', hidden: true }),
    h('div', { class: 'layout' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'side-head' },
          h('div', {}, h('div', { class: 'side-title', text: 'Accounts' }), h('div', { class: 'side-sub', id: 'acc-count' })),
          h('button', { class: 'btn primary small', id: 'add-account', onclick: () => addAccountDialog(app) }, icon('plus', 14), 'Add')),
        h('div', { class: 'bulk' },
          h('label', { class: 'check-all' }, h('input', { type: 'checkbox', id: 'select-all', onchange: (e) => toggleAll(e.target.checked) }), h('span', { id: 'select-label', text: 'Select all' })),
          h('div', { class: 'bulk-actions' },
            h('button', { class: 'btn small go', id: 'connect-sel', onclick: () => connectSelected() }, icon('play', 12), 'Connect'),
            h('button', { class: 'btn small ghost', id: 'disconnect-sel', onclick: () => disconnectSelected() }, icon('stop', 12), 'Disconnect'))),
        h('ul', { class: 'accounts', id: 'accounts', role: 'list' }),
        h('div', { class: 'side-empty', id: 'accounts-empty', hidden: true },
          icon('users', 28),
          h('p', { text: 'No accounts yet.' }),
          h('button', { class: 'btn primary', onclick: () => addAccountDialog(app) }, icon('plus', 14), 'Add Microsoft account'))),
      h('main', { class: 'main' },
        h('div', { class: 'toolbar', id: 'toolbar' },
          h('div', { class: 'tabs', role: 'tablist' },
            h('button', { class: 'tab active', id: 'tab-chat', role: 'tab', onclick: () => setTab('chat') }, icon('chat', 14), 'Chat'),
            h('button', { class: 'tab', id: 'tab-players', role: 'tab', onclick: () => setTab('players') }, icon('users', 14), 'Players'),
            h('button', { class: 'tab', id: 'tab-pov', role: 'tab', title: 'See through an account\'s eyes and control it', onclick: () => setTab('pov') }, icon('eye', 14), 'POV'),
            h('button', { class: 'tab', id: 'tab-macros', role: 'tab', title: 'Make accounts do things by themselves', onclick: () => setTab('macros') }, icon('bolt', 14), 'Macros')),
          h('div', { class: 'chat-tools', id: 'chat-tools' },
            h('label', { class: 'view-pick' }, h('span', { class: 'muted', text: 'Showing' }), h('select', { class: 'input slim', id: 'view-filter', onchange: (e) => { app.filter.view = e.target.value; store('view', app.filter.view); app.chat.rerender() } })),
            h('div', { class: 'search' }, icon('search', 14), h('input', { class: 'input slim', id: 'chat-search', placeholder: 'Search chat', oninput: debounce((e) => { app.filter.search = e.target.value.trim().toLowerCase(); app.chat.rerender() }, 200) })),
            h('button', { class: 'icon-btn', title: 'Clear chat window', 'aria-label': 'Clear chat window', onclick: () => app.chat.clear() }, icon('trash', 15)))),
        h('div', { class: 'chat-wrap', id: 'chat-panel' },
          h('div', { class: 'onboarding', id: 'onboarding', hidden: true }),
          h('div', { class: 'chat-lines', id: 'chat-lines', role: 'log', 'aria-live': 'polite' }),
          h('button', { class: 'jump', id: 'jump-latest', hidden: true, onclick: () => app.chat.scrollToEnd() }, icon('down', 13), h('span', { text: '' }))),
        h('div', { class: 'players-wrap', id: 'players-panel', hidden: true }),
        h('div', { class: 'pov-wrap', id: 'pov-panel', hidden: true }),
        h('div', { class: 'macros-wrap', id: 'macros-panel', hidden: true }),
        h('footer', { class: 'composer', id: 'composer' },
          h('div', { class: 'senders', id: 'senders' }),
          h('form', { class: 'send-row', onsubmit: (e) => { e.preventDefault(); sendMessage() } },
            h('input', { class: 'input chat-input', id: 'chat-input', placeholder: 'Type a message or /command', maxlength: 256, autocomplete: 'off', spellcheck: 'false' }),
            h('button', { class: 'btn primary', id: 'send-btn', type: 'submit' }, icon('send', 14), 'Send'))))),
    h('footer', { class: 'statusbar', id: 'statusbar' }))

  const input = $('#chat-input')
  input.addEventListener('keydown', onInputKey)
  const savedView = store('view')
  if (savedView) app.filter.view = savedView
}

function renderAll () {
  renderServerBar()
  renderAccounts()
  renderViewFilter()
  renderComposer()
  renderStatusbar()
  renderOnboarding()
  renderSecureBanner()
}

// ------------------------------------------------------------------ server bar
function renderServerBar () {
  const bar = $('#server-bar')
  clear(bar)
  const s = currentServer()
  const btn = h('button', { class: 'server-btn', id: 'server-btn', onclick: (e) => serverMenu(e.currentTarget) },
    app.lastPing && app.lastPing.serverId === s?.id && app.lastPing.favicon
      ? h('img', { class: 'favicon small', src: app.lastPing.favicon, alt: '' })
      : h('span', { class: 'server-icon' }, icon('server', 16)),
    h('span', { class: 'server-text' },
      h('span', { class: 'server-name', text: s ? s.name : 'Add a server' }),
      s ? h('span', { class: 'server-addr', text: `${s.host}${s.port !== 25565 ? ':' + s.port : ''}` }) : null),
    icon('chevron', 14))
  bar.appendChild(btn)
  if (s) {
    const vsel = versionSelect(app.state.versions, s.version)
    vsel.classList.add('slim')
    vsel.id = 'version-select'
    vsel.title = 'Minecraft version used to join this server'
    vsel.addEventListener('change', async () => {
      try {
        await api.call('saveServer', { ...s, address: `${s.host}:${s.port}`, version: vsel.value })
        const online = onlineIds().filter(id => app.state.slots[id]?.serverId === s.id)
        if (online.length) {
          toast(`Version changed to ${vsel.value === 'auto' ? 'auto-detect' : vsel.value}. Online accounts keep their current connection.`, {
            action: { label: 'Reconnect them', onClick: () => api.call('reconnect', online) }
          })
        }
      } catch (e) { toast(cleanError(e), { kind: 'error' }) }
    })
    bar.appendChild(h('label', { class: 'version-pick' }, h('span', { class: 'muted', text: 'Version' }), vsel))
    const chip = h('div', { class: 'ping-chip', id: 'ping-chip' })
    if (app.lastPing && app.lastPing.serverId === s.id) fillPingChip(chip, app.lastPing)
    bar.appendChild(h('button', { class: 'btn ghost small', id: 'ping-btn', title: 'Check the server is online', onclick: () => pingCurrent() }, icon('signal', 13), 'Ping'))
    bar.appendChild(chip)
  } else {
    btn.classList.add('empty')
  }
}

function fillPingChip (chip, r) {
  clear(chip)
  if (r.error) {
    chip.className = 'ping-chip bad'
    chip.append(icon('alert', 13), h('span', { text: r.error }))
    return
  }
  chip.className = 'ping-chip good'
  chip.title = r.motd || ''
  chip.append(h('span', { class: 'dot on' }), h('span', { text: `${r.players.online}/${r.players.max}` }), h('span', { class: 'sep', text: '·' }), h('span', { text: r.versionName || '?' }), h('span', { class: 'sep', text: '·' }), h('span', { text: `${r.latency} ms` }))
}

async function pingCurrent () {
  const s = currentServer()
  if (!s) return
  const chip = $('#ping-chip')
  clear(chip).append(h('div', { class: 'spinner tiny' }), h('span', { class: 'muted', text: 'Pinging…' }))
  chip.className = 'ping-chip'
  try {
    const r = await api.call('pingServer', `${s.host}:${s.port}`)
    app.lastPing = { ...r, serverId: s.id }
  } catch (e) {
    app.lastPing = { serverId: s.id, error: cleanError(e) }
  }
  renderServerBar()
}

function serverMenu (anchor) {
  const items = app.state.servers.map(s => ({
    label: s.name,
    sub: `${s.host}${s.port !== 25565 ? ':' + s.port : ''} · ${s.version === 'auto' ? 'auto' : s.version}`,
    checked: s.id === app.state.selectedServerId,
    onClick: () => selectServer(s.id),
    trailing: { icon: 'edit', title: 'Edit server', onClick: () => serverDialog(app, s) }
  }))
  if (items.length) items.push({ separator: true })
  items.push({ label: 'Add a server…', icon: 'plus', onClick: () => serverDialog(app, null) })
  popover(anchor, items, 'server-menu')
}

async function selectServer (id) {
  if (id === app.state.selectedServerId) return
  await api.call('selectServer', id)
  app.lastPing = null
  const online = onlineIds().filter(aid => app.state.slots[aid]?.serverId && app.state.slots[aid].serverId !== id)
  const s = app.state.servers.find(x => x.id === id)
  if (online.length) {
    toast(`${online.length} account${online.length === 1 ? ' is' : 's are'} still on the previous server.`, {
      action: { label: `Move to ${s?.name || 'this server'}`, onClick: () => api.call('reconnect', online) }
    })
  }
}

// ------------------------------------------------------------------ accounts
function statusText (id) {
  const slot = app.state.slots[id] || { status: 'offline' }
  const acc = app.state.accounts.find(a => a.id === id)
  if (acc && acc.needsSignIn && slot.status !== 'online') return { tone: 'err', text: 'Sign in again' }
  const now = Date.now()
  switch (slot.status) {
    case 'online': {
      const st = slot.stats || {}
      const bits = ['Online']
      if (Number.isFinite(st.ping)) bits.push(`${st.ping} ms`)
      if (Number.isFinite(st.health)) bits.push(`♥ ${Math.round(st.health)}`)
      const extra = [
        st.onlineSince ? `Online for ${duration(now - st.onlineSince)}` : null,
        slot.server, slot.version,
        Number.isFinite(st.food) ? `Food ${st.food}/20` : null,
        st.position ? `XYZ ${Math.round(st.position.x)} ${Math.round(st.position.y)} ${Math.round(st.position.z)}` : null,
        st.dimension
      ].filter(Boolean)
      return { tone: 'on', text: bits.join(' · '), title: extra.join(' · ') }
    }
    case 'queued': {
      const q = app.state.queue || {}
      let t = slot.queuePosition ? `Queued #${slot.queuePosition}` : 'Queued'
      if (slot.queuePosition === 1 && q.nextLoginAt > now) t += ` · ${Math.ceil((q.nextLoginAt - now) / 1000)}s`
      if (slot.attempts) t += ` · retry ${slot.attempts}`
      return { tone: 'wait', text: t }
    }
    case 'waiting': {
      const secs = Math.max(0, Math.ceil((slot.nextAttemptAt - now) / 1000))
      return { tone: 'wait', text: `Retry in ${duration(secs * 1000)}`, detail: slot.message, title: slot.message }
    }
    case 'stopped':
      return { tone: 'err', text: 'Stopped', detail: slot.message, title: slot.message }
    case 'needs_sign_in':
      return { tone: 'err', text: 'Sign in again', detail: slot.message }
    case 'offline':
      return { tone: 'off', text: slot.message && slot.message !== 'Disconnected' ? 'Offline' : 'Offline', detail: slot.message && slot.message !== 'Disconnected' ? slot.message : '' }
    default:
      return { tone: STATUS[slot.status]?.tone || 'busy', text: STATUS[slot.status]?.label || slot.status }
  }
}

function renderAccounts () {
  const list = $('#accounts')
  const accounts = app.state.accounts
  $('#accounts-empty').hidden = accounts.length > 0
  const online = onlineIds().length
  $('#acc-count').textContent = accounts.length ? `${online} of ${accounts.length} online` : ''

  const seen = new Set()
  accounts.forEach((acc, index) => {
    seen.add(acc.id)
    let row = app.rows.get(acc.id)
    if (!row) {
      row = buildRow(acc)
      app.rows.set(acc.id, row)
    }
    updateRow(row, acc)
    if (list.children[index] !== row.el) list.insertBefore(row.el, list.children[index] || null)
  })
  for (const [id, row] of app.rows) {
    if (!seen.has(id)) { row.el.remove(); app.rows.delete(id) }
  }
  const all = $('#select-all')
  const selCount = accounts.filter(a => app.selected.has(a.id)).length
  all.checked = accounts.length > 0 && selCount === accounts.length
  all.indeterminate = selCount > 0 && selCount < accounts.length
  $('#select-label').textContent = selCount ? `${selCount} selected` : 'Select all'
  $('#connect-sel').disabled = selCount === 0
  $('#disconnect-sel').disabled = selCount === 0
}

function buildRow (acc) {
  const check = h('input', { type: 'checkbox', class: 'acc-check', 'aria-label': `Select ${acc.name}` })
  check.addEventListener('change', () => app.selectAccount(acc.id, check.checked))
  const face = h('img', { class: 'face', alt: '' })
  const name = h('span', { class: 'acc-name' })
  const dot = h('span', { class: 'dot' })
  const status = h('span', { class: 'acc-status-text' })
  const detail = h('div', { class: 'acc-detail' })
  const power = h('button', { class: 'icon-btn power', 'aria-label': 'Connect' })
  power.addEventListener('click', (e) => { e.stopPropagation(); togglePower(acc.id) })
  const more = h('button', { class: 'icon-btn', title: 'More', 'aria-label': `More options for ${acc.name}` }, icon('more', 16))
  more.addEventListener('click', (e) => { e.stopPropagation(); accountMenu(more, acc.id) })
  const el = h('li', { class: 'account', dataset: { id: acc.id } },
    h('label', { class: 'acc-check-wrap', onclick: (e) => e.stopPropagation() }, check),
    face,
    h('div', { class: 'acc-main' }, h('div', { class: 'acc-top' }, name), h('div', { class: 'acc-status' }, dot, status), detail),
    h('div', { class: 'acc-actions' }, power, more))
  el.addEventListener('click', () => app.selectAccount(acc.id, !app.selected.has(acc.id)))
  el.addEventListener('dblclick', () => setView(acc.id))
  loadFace(acc, face)
  return { el, check, face, name, dot, status, detail, power, more, accId: acc.id }
}

function updateRow (row, acc) {
  const slot = app.state.slots[acc.id] || { status: 'offline' }
  const st = statusText(acc.id)
  row.name.textContent = acc.name
  row.el.classList.toggle('selected', app.selected.has(acc.id))
  row.check.checked = app.selected.has(acc.id)
  row.dot.className = `dot ${st.tone}`
  row.status.textContent = st.text
  row.el.title = st.title || ''
  row.detail.textContent = st.detail || ''
  row.detail.hidden = !st.detail
  row.detail.className = `acc-detail ${st.tone === 'err' ? 'err' : ''}`
  const active = ['queued', 'signing_in', 'connecting', 'logging_in', 'online', 'waiting'].includes(slot.status)
  clear(row.power).appendChild(icon(active ? 'stop' : 'play', 13))
  row.power.className = `icon-btn power ${active ? 'stop' : 'go'}`
  const label = acc.needsSignIn && !active ? `Sign in ${acc.name} again` : active ? `Disconnect ${acc.name}` : `Connect ${acc.name}`
  row.power.title = label
  row.power.setAttribute('aria-label', label)
}

async function loadFace (acc, img) {
  const cached = app.faces.get(acc.id)
  if (cached) { img.src = cached; return }
  img.src = defaultFace(acc.name)
  try {
    const skin = await api.call('getSkin', acc.id)
    if (!skin) return
    const url = await cropFace(skin)
    app.faces.set(acc.id, url)
    img.src = url
  } catch { }
}

function defaultFace (name) {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')
  g.fillStyle = `hsl(${nameHue(name)} 45% 32%)`
  g.fillRect(0, 0, 32, 32)
  g.fillStyle = 'rgba(255,255,255,.85)'
  g.font = 'bold 16px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(String(name || '?').charAt(0).toUpperCase(), 16, 17)
  return c.toDataURL()
}

function cropFace (skinDataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = 32
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = false
      g.drawImage(img, 8, 8, 8, 8, 0, 0, 32, 32) // face
      g.drawImage(img, 40, 8, 8, 8, 0, 0, 32, 32) // hat layer
      resolve(c.toDataURL())
    }
    img.onerror = reject
    img.src = skinDataUrl
  })
}

async function togglePower (id) {
  const slot = app.state.slots[id] || { status: 'offline' }
  const acc = app.state.accounts.find(a => a.id === id)
  const active = ['queued', 'signing_in', 'connecting', 'logging_in', 'online', 'waiting'].includes(slot.status)
  if (active) return api.call('disconnect', [id])
  if (acc?.needsSignIn) return addAccountDialog(app)
  await connectIds([id])
}

async function connectIds (ids) {
  if (!currentServer()) {
    toast('Add a server first.', { action: { label: 'Add server', onClick: () => serverDialog(app, null) } })
    return
  }
  const needSignIn = app.state.accounts.filter(a => ids.includes(a.id) && a.needsSignIn)
  if (needSignIn.length) toast(`${needSignIn.map(a => a.name).join(', ')} need${needSignIn.length === 1 ? 's' : ''} to sign in again first.`, { kind: 'warn', action: { label: 'Sign in', onClick: () => addAccountDialog(app) } })
  try {
    await api.call('connect', ids.filter(id => !needSignIn.some(a => a.id === id)))
  } catch (e) {
    toast(cleanError(e), { kind: 'error' })
  }
}

function connectSelected () {
  const ids = app.state.accounts.filter(a => app.selected.has(a.id)).map(a => a.id)
  if (ids.length) connectIds(ids)
}

function disconnectSelected () {
  const ids = app.state.accounts.filter(a => app.selected.has(a.id)).map(a => a.id)
  if (ids.length) api.call('disconnect', ids)
}

function toggleAll (on) {
  if (on) app.state.accounts.forEach(a => app.selected.add(a.id))
  else app.selected.clear()
  saveSelection()
  renderAccounts()
  renderComposer()
  if (app.filter.view === 'selected') app.chat.rerender()
}

function accountMenu (anchor, id) {
  const acc = app.state.accounts.find(a => a.id === id)
  const slot = app.state.slots[id] || { status: 'offline' }
  if (!acc) return
  const index = app.state.accounts.indexOf(acc)
  const items = [
    { label: 'Show only this account\'s chat', icon: 'chat', onClick: () => setView(id) },
    slot.status === 'online' ? { label: 'Open POV (see and control)', icon: 'eye', onClick: () => openPov(id) } : null,
    slot.status === 'online' && app.macros.macros.length ? { label: 'Run a macro on it…', icon: 'bolt', onClick: () => setTimeout(() => macroMenu(anchor, id), 0) } : null,
    slot.status === 'online' ? { label: 'Show players online', icon: 'users', onClick: () => { app.playersAccount = id; setTab('players') } } : null,
    slot.status !== 'offline' && slot.status !== 'needs_sign_in' ? { label: 'Reconnect', icon: 'refresh', onClick: () => api.call('reconnect', [id]) } : null,
    { label: 'Sign in again', icon: 'key', onClick: () => addAccountDialog(app) },
    { label: 'Copy UUID', icon: 'copy', onClick: () => api.call('copyText', acc.uuid).then(() => toast('UUID copied')) },
    index > 0 ? { label: 'Move up', icon: 'up', onClick: () => api.call('moveAccount', id, index - 1) } : null,
    index < app.state.accounts.length - 1 ? { label: 'Move down', icon: 'down', onClick: () => api.call('moveAccount', id, index + 1) } : null,
    { separator: true },
    {
      label: 'Remove account',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({ title: `Remove ${acc.name}?`, message: 'Disconnects it and deletes its saved sign-in from this PC. You can add it again any time.', confirmLabel: 'Remove', danger: true })
        if (ok) { await api.call('removeAccount', id); app.faces.delete(id) }
      }
    }
  ].filter(Boolean)
  popover(anchor, items)
}

// ------------------------------------------------------------------ chat view / composer
function setTab (tab, povAccount) {
  const was = app.tab
  app.tab = tab
  for (const t of ['chat', 'players', 'pov', 'macros']) $(`#tab-${t}`).classList.toggle('active', tab === t)
  $('#chat-panel').hidden = tab !== 'chat'
  $('#chat-tools').hidden = tab !== 'chat'
  $('#players-panel').hidden = tab !== 'players'
  $('#pov-panel').hidden = tab !== 'pov'
  $('#macros-panel').hidden = tab !== 'macros'
  // the POV view has its own chat box (for the account it shows); the macro editor needs the room
  $('#composer').hidden = tab === 'pov' || tab === 'macros'
  if (tab === 'players') renderPlayers()
  if (tab === 'macros') app.macros.show()
  if (tab === 'pov') app.pov.show(povAccount)
  else if (was === 'pov') app.pov.hide()
}

function openPov (id) {
  if (app.tab === 'pov') app.pov.open(id)
  else setTab('pov', id)
}

function macroMenu (anchor, id) {
  popover(anchor, app.macros.macros.map(m => ({ label: m.name, icon: 'play', onClick: () => app.macros.run(m.id, [id]) })))
}

// clickable chat text from a server ("[ACCEPT]", "[Click to confirm]", links)
function chatClick (k, accIds, anchor) {
  if (k.a === 'open_url' || k.a === 'copy_to_clipboard') {
    api.call('copyText', k.v).then(() => toast(k.a === 'open_url' ? `Link copied: ${k.v.slice(0, 80)}` : 'Copied'))
    return
  }
  const names = accountsById()
  const online = accIds.filter(id => app.state.slots[id]?.status === 'online')
  if (k.a === 'suggest_command') {
    if (app.tab === 'pov') return app.pov.suggest(k.v)
    const input = $('#chat-input')
    input.value = k.v
    input.focus()
    return
  }
  // run_command: from the account that got the message (or pick, if several did)
  if (!online.length) return toast('The account that got this message isn\'t online any more.', { kind: 'warn' })
  const run = (ids) => api.call('sendChat', k.v, ids)
  if (online.length === 1) return run(online)
  popover(anchor, [
    { label: `Run ${k.v.slice(0, 40)} from all ${online.length}`, icon: 'send', onClick: () => run(online) },
    { separator: true },
    ...online.map(id => ({ label: names.get(id)?.name || id, icon: 'play', onClick: () => run([id]) }))
  ])
}

function setView (view) {
  app.filter.view = view
  store('view', view)
  renderViewFilter()
  setTab('chat')
  app.chat.rerender()
}

function renderViewFilter () {
  const sel = $('#view-filter')
  clear(sel)
  sel.append(h('option', { value: 'all', text: 'All accounts' }), h('option', { value: 'selected', text: 'Selected accounts' }))
  const group = h('optgroup', { label: 'One account' })
  for (const a of app.state.accounts) group.appendChild(h('option', { value: a.id, text: a.name }))
  if (app.state.accounts.length) sel.appendChild(group)
  if (app.filter.view !== 'all' && app.filter.view !== 'selected' && !app.state.accounts.some(a => a.id === app.filter.view)) {
    // the account being viewed was removed: go back to everything
    app.filter.view = 'all'
    store('view', 'all')
    if (app.chat) app.chat.rerender()
  }
  sel.value = app.filter.view
}

function renderComposer () {
  const box = $('#senders')
  clear(box)
  const byId = accountsById()
  const chosen = app.state.accounts.filter(a => app.selected.has(a.id))
  const onlineChosen = chosen.filter(a => app.state.slots[a.id]?.status === 'online')
  box.appendChild(h('span', { class: 'senders-label', text: 'Send from' }))
  if (!chosen.length) {
    const online = onlineIds()
    box.appendChild(h('span', { class: 'muted', text: online.length ? 'no accounts selected. Tick accounts on the left, or' : 'no accounts selected. Tick accounts on the left.' }))
    if (online.length) box.appendChild(h('button', { class: 'chip add', onclick: () => { online.forEach(id => app.selected.add(id)); saveSelection(); renderAccounts(); renderComposer() } }, icon('plus', 11), `select all online (${online.length})`))
  }
  for (const a of chosen) {
    const on = app.state.slots[a.id]?.status === 'online'
    const chip = h('span', { class: `chip${on ? '' : ' off'}`, title: on ? `${a.name} will send` : `${a.name} is offline and won't send` },
      h('span', { class: `dot ${on ? 'on' : 'off'}` }),
      h('span', { text: byId.get(a.id)?.name || a.name }),
      h('button', { class: 'chip-x', 'aria-label': `Stop sending from ${a.name}`, onclick: () => app.selectAccount(a.id, false) }, icon('close', 10)))
    chip.style.setProperty('--hue', String(nameHue(a.name)))
    box.appendChild(chip)
  }
  const input = $('#chat-input')
  const btn = $('#send-btn')
  btn.disabled = onlineChosen.length === 0
  input.placeholder = onlineChosen.length
    ? `Message or /command from ${onlineChosen.length === 1 ? onlineChosen[0].name : onlineChosen.length + ' accounts'}`
    : chosen.length ? 'Selected accounts are offline' : 'Select accounts to chat'
}

async function sendMessage () {
  const input = $('#chat-input')
  const text = input.value.trim()
  if (!text) return
  const ids = app.state.accounts.filter(a => app.selected.has(a.id) && app.state.slots[a.id]?.status === 'online').map(a => a.id)
  if (!ids.length) { toast('None of the selected accounts are online.', { kind: 'warn' }); return }
  try {
    const res = await api.call('sendChat', text, ids)
    if (res.skipped) toast(`${res.skipped} account${res.skipped === 1 ? ' was' : 's were'} offline and didn't send.`, { kind: 'warn' })
    // commands that carry a password (/login, /register, ...) are never remembered
    if (!SECRET_COMMAND.test(text) && app.inputHistory[app.inputHistory.length - 1] !== text) app.inputHistory.push(text)
    if (app.inputHistory.length > 100) app.inputHistory.shift()
    store('inputHistory', app.inputHistory)
    app.historyIndex = -1
    input.value = ''
  } catch (e) {
    toast(cleanError(e), { kind: 'error' })
  }
}

function onInputKey (e) {
  const input = e.target
  if (e.key === 'ArrowUp' && app.inputHistory.length) {
    e.preventDefault()
    if (app.historyIndex === -1) app.historyIndex = app.inputHistory.length
    app.historyIndex = Math.max(0, app.historyIndex - 1)
    input.value = app.inputHistory[app.historyIndex]
  } else if (e.key === 'ArrowDown' && app.historyIndex !== -1) {
    e.preventDefault()
    app.historyIndex++
    if (app.historyIndex >= app.inputHistory.length) { app.historyIndex = -1; input.value = '' } else input.value = app.inputHistory[app.historyIndex]
  }
}

// ------------------------------------------------------------------ players
function renderPlayersPicker () {
  const sel = $('#players-account')
  if (!sel) return
  const online = onlineIds()
  const prev = sel.value
  clear(sel)
  for (const id of online) sel.appendChild(h('option', { value: id, text: app.state.accounts.find(a => a.id === id)?.name }))
  if (online.includes(prev)) sel.value = prev
}

function renderPlayers () {
  const panel = $('#players-panel')
  clear(panel)
  const online = onlineIds()
  if (!online.length) {
    panel.appendChild(h('div', { class: 'chat-empty' }, icon('users', 28), h('div', { text: 'Connect an account to see who\'s online.' })))
    return
  }
  if (!online.includes(app.playersAccount)) app.playersAccount = online[0]
  const sel = h('select', { class: 'input slim', id: 'players-account', onchange: (e) => { app.playersAccount = e.target.value; refreshPlayers() } })
  const head = h('div', { class: 'players-head' }, h('span', { class: 'muted', text: 'Tab list as seen by' }), sel, h('span', { class: 'muted', id: 'players-count' }))
  const grid = h('div', { class: 'players-grid', id: 'players-grid' })
  panel.append(head, grid)
  renderPlayersPicker()
  sel.value = app.playersAccount
  refreshPlayers()
}

async function refreshPlayers () {
  if (app.tab !== 'players') return
  const grid = $('#players-grid')
  if (!grid) return
  const list = await api.call('getPlayers', app.playersAccount)
  list.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))
  clear(grid)
  $('#players-count').textContent = `${list.length} player${list.length === 1 ? '' : 's'}`
  if (!list.length) grid.appendChild(h('div', { class: 'muted', text: 'The server hasn\'t sent a player list to this account yet.' }))
  for (const p of list) {
    const ping = Number(p.ping)
    const bars = ping < 0 ? 0 : ping < 150 ? 4 : ping < 300 ? 3 : ping < 600 ? 2 : 1
    grid.appendChild(h('div', { class: 'player' },
      h('span', { class: 'p-name', text: p.name }),
      h('span', { class: `p-ping b${bars}`, title: `${ping} ms` }, icon('signal', 12), h('span', { text: Number.isFinite(ping) ? `${ping}` : '?' }))))
  }
}

// ------------------------------------------------------------------ status, banners, onboarding
function renderStatusbar () {
  const bar = $('#statusbar')
  clear(bar)
  const online = onlineIds().length
  const total = app.state.accounts.length
  const q = app.state.queue || { length: 0 }
  const waiting = Object.values(app.state.slots).filter(s => s.status === 'waiting').length
  append(bar, [
    h('span', { class: 'sb-item' }, h('span', { class: `dot ${online ? 'on' : 'off'}` }), `${online}/${total} online`),
    q.length ? h('span', { class: 'sb-item', id: 'sb-queue', text: queueText(q) }) : null,
    waiting ? h('span', { class: 'sb-item', text: `${waiting} waiting to reconnect` }) : null,
    h('span', { class: 'sb-item muted', text: app.state.settings.autoReconnect ? 'Auto-reconnect on' : 'Auto-reconnect off' }),
    h('span', { class: 'sb-spacer' }),
    h('button', { class: `sb-item sb-secure ${app.state.secureStorage.available ? 'ok' : 'warn'}`, onclick: () => privacyDialog(app) },
      icon(app.state.secureStorage.available ? 'shield' : 'alert', 12),
      app.state.secureStorage.available ? 'Sign-ins encrypted' : 'Sign-ins not saved'),
    h('span', { class: 'sb-item muted', text: app.state.author ? `v${app.state.appVersion} · made by ${app.state.author}` : `v${app.state.appVersion}` })])
}

function queueText (q) {
  const secs = Math.max(0, Math.ceil((q.nextLoginAt - Date.now()) / 1000))
  return `${q.length} in login queue${q.nextLoginAt && secs > 0 ? ` · next in ${secs}s` : ''}`
}

function renderSecureBanner () {
  const b = $('#secure-banner')
  if (app.state.secureStorage.available) { b.hidden = true; return }
  b.hidden = false
  clear(b).append(icon('alert', 14), h('span', { text: 'This system has no secure key storage, so sign-ins are kept in memory only and you\'ll sign in again after restarting MineDeck.' }))
}

function renderOnboarding () {
  const box = $('#onboarding')
  const noServer = app.state.servers.length === 0
  const noAccount = app.state.accounts.length === 0
  if (!noServer && !noAccount) { box.hidden = true; return }
  box.hidden = false
  clear(box).append(
    h('h2', { text: 'Welcome to MineDeck' }),
    h('p', { class: 'muted', text: 'Run several Minecraft accounts at once and chat from any of them.' }),
    h('ol', { class: 'onboard-steps' },
      h('li', { class: noServer ? '' : 'done' }, h('span', { class: 'step-n' }, noServer ? '1' : icon('check', 12)), h('div', {}, h('b', { text: 'Add a server' }), h('p', { class: 'muted', text: 'Enter the address. MineDeck can detect the version for you.' })), noServer ? h('button', { class: 'btn primary small', onclick: () => serverDialog(app, null) }, icon('plus', 13), 'Add server') : null),
      h('li', { class: noAccount ? '' : 'done' }, h('span', { class: 'step-n' }, noAccount ? '2' : icon('check', 12)), h('div', {}, h('b', { text: 'Add your Microsoft accounts' }), h('p', { class: 'muted', text: 'Sign in once on Microsoft\'s website. MineDeck remembers it (encrypted) and never sees passwords.' })), noAccount ? h('button', { class: 'btn primary small', onclick: () => addAccountDialog(app) }, icon('plus', 13), 'Add account') : null),
      h('li', {}, h('span', { class: 'step-n', text: '3' }), h('div', {}, h('b', { text: 'Select accounts and press Connect' }), h('p', { class: 'muted', text: 'They log in one by one with a delay, and reconnect automatically.' })))))
}

// ------------------------------------------------------------------ popover & toasts
let openPopover = null
function popover (anchor, items, cls = '') {
  if (openPopover) openPopover.close()
  const menu = h('div', { class: `popover ${cls}`, role: 'menu' })
  for (const it of items) {
    if (it.separator) { menu.appendChild(h('div', { class: 'pop-sep' })); continue }
    const row = h('div', { class: `pop-item${it.danger ? ' danger' : ''}${it.checked ? ' checked' : ''}`, role: 'menuitem', tabindex: '0' },
      h('span', { class: 'pop-icon' }, it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 14) : null),
      h('span', { class: 'pop-text' }, h('span', { text: it.label }), it.sub ? h('span', { class: 'pop-sub', text: it.sub }) : null))
    if (it.trailing) {
      const t = h('button', { class: 'icon-btn small', title: it.trailing.title, 'aria-label': it.trailing.title }, icon(it.trailing.icon, 13))
      t.addEventListener('click', (e) => { e.stopPropagation(); close(); it.trailing.onClick() })
      row.appendChild(t)
    }
    const activate = () => { close(); it.onClick && it.onClick() }
    row.addEventListener('click', activate)
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() } })
    menu.appendChild(row)
  }
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = Math.min(r.left, window.innerWidth - mw - 8)
  let top = r.bottom + 4
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4)
  if (left < 8) left = 8
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close() }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  function close () {
    menu.remove()
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    if (openPopover && openPopover.menu === menu) openPopover = null
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    menu.querySelector('.pop-item')?.focus()
  }, 0)
  openPopover = { menu, close }
}

function toast (text, { kind = 'info', action, timeout = 6000 } = {}) {
  const box = $('#toasts')
  const el = h('div', { class: `toast ${kind}`, role: 'status' },
    icon(kind === 'error' || kind === 'warn' ? 'alert' : 'check', 14),
    h('span', { class: 'toast-text', text }))
  if (action) el.appendChild(h('button', { class: 'btn small', onclick: () => { el.remove(); action.onClick() } }, action.label))
  el.appendChild(h('button', { class: 'icon-btn small', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('close', 12)))
  box.appendChild(el)
  while (box.children.length > 4) box.firstChild.remove()
  setTimeout(() => el.remove(), action ? timeout * 2 : timeout)
}

// ------------------------------------------------------------------ timers & keys
function tick () {
  // countdowns ("retry in 12s", queue timer)
  for (const acc of app.state.accounts) {
    const s = app.state.slots[acc.id]
    if (!s || !['waiting', 'queued', 'online'].includes(s.status)) continue
    const row = app.rows.get(acc.id)
    if (row) updateRow(row, acc)
  }
  const q = $('#sb-queue')
  if (q && app.state.queue?.length) q.textContent = queueText(app.state.queue)
  if (app.tab === 'players' && Date.now() % 3000 < 1000) refreshPlayers()
}

document.addEventListener('keydown', (e) => {
  if (isModalOpen()) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setTab('chat'); $('#chat-search').focus() }
  if (/^F([1-9]|1[0-2])$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey && app.macros?.hotkey(e.key)) { e.preventDefault(); return }
  if (app.tab === 'pov' || app.tab === 'macros') return // these tabs handle their own keys
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault()
    const input = $('#chat-input')
    input.focus()
    if (!input.value) input.value = '/'
  }
})

boot().catch((e) => {
  document.body.textContent = `MineDeck failed to start: ${e.message}`
})

export { openModal }
