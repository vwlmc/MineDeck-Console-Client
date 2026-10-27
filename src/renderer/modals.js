// Dialogs: generic modal, add account (Microsoft device code), server editor,
// settings, and confirmations.
import { h, clear, debounce } from './ui.js'
import { icon } from './icons.js'
import { renderSegments } from './chat.js'

const api = window.minedeck
const root = () => document.getElementById('modal-root')
let openCount = 0

export function openModal ({ title, subtitle, body, actions = [], onClose, wide = false, sticky = false }) {
  const prevFocus = document.activeElement
  const close = () => {
    if (!backdrop.isConnected) return
    backdrop.remove()
    document.removeEventListener('keydown', onKey, true)
    openCount--
    if (onClose) onClose()
    if (prevFocus && prevFocus.focus) prevFocus.focus()
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && !sticky) { e.preventDefault(); close() }
  }
  const bodyEl = h('div', { class: 'modal-body' }, body)
  const footer = h('div', { class: 'modal-actions' })
  const setActions = (list) => {
    clear(footer)
    for (const a of list) {
      const b = h('button', { class: `btn ${a.kind || ''}`, type: 'button', disabled: a.disabled, onclick: () => a.onClick && a.onClick({ close, button: b }) }, a.icon ? icon(a.icon, 14) : null, a.label)
      if (a.id) b.id = a.id
      footer.appendChild(b)
    }
    footer.hidden = list.length === 0
  }
  setActions(actions)
  const dialog = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('div', {}, h('h2', { text: title }), subtitle ? h('p', { class: 'muted', text: subtitle }) : null),
      sticky ? null : h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: close }, icon('close', 16))),
    bodyEl,
    footer)
  const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop && !sticky) close() } }, dialog)
  root().appendChild(backdrop)
  document.addEventListener('keydown', onKey, true)
  openCount++
  setTimeout(() => {
    const f = dialog.querySelector('[autofocus], input, select, textarea, .btn.primary')
    if (f) f.focus()
  }, 30)
  return {
    close,
    el: dialog,
    setBody: (node) => { clear(bodyEl); bodyEl.appendChild(node) },
    setActions
  }
}

export const isModalOpen = () => openCount > 0

export function confirmDialog ({ title, message, confirmLabel = 'Confirm', danger = false, typeToConfirm }) {
  return new Promise((resolve) => {
    let input = null
    const body = h('div', {}, h('p', { text: message }))
    if (typeToConfirm) {
      input = h('input', { class: 'input', placeholder: `Type ${typeToConfirm} to confirm`, autocomplete: 'off' })
      body.appendChild(input)
    }
    let result = false
    const m = openModal({
      title,
      body,
      onClose: () => resolve(result),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: ({ close }) => close() },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: ({ close }) => {
            if (typeToConfirm && input.value.trim() !== typeToConfirm) { input.classList.add('invalid'); input.focus(); return }
            result = true
            close()
          }
        }
      ]
    })
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.el.querySelector('.btn.danger, .btn.primary').click() })
  })
}

// ------------------------------------------------------------------ add account
export function addAccountDialog (app) {
  let flowId = null
  let timer = null
  let unsub = null

  const intro = () => h('div', { class: 'signin' },
    h('div', { class: 'signin-hero' }, icon('shield', 34)),
    h('p', { text: 'You\'ll sign in on Microsoft\'s own website using a short code.' }),
    h('ul', { class: 'checklist' },
      h('li', {}, icon('check', 14), 'MineDeck never sees your password'),
      h('li', {}, icon('check', 14), 'You sign in once: it\'s remembered, encrypted, on this PC only'),
      h('li', {}, icon('check', 14), 'Use any Microsoft account that owns Minecraft: Java Edition')))

  const m = openModal({
    title: 'Add a Microsoft account',
    body: intro(),
    onClose: () => {
      clearInterval(timer)
      if (unsub) unsub()
      if (flowId) api.call('cancelAddAccount', flowId)
    },
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: ({ close }) => close() },
      { label: 'Start sign-in', kind: 'primary', icon: 'key', onClick: () => start() }
    ]
  })

  function waiting () {
    m.setBody(h('div', { class: 'signin center' }, h('div', { class: 'spinner' }), h('p', { class: 'muted', text: 'Getting a sign-in code from Microsoft…' })))
    m.setActions([{ label: 'Cancel', kind: 'ghost', onClick: ({ close }) => close() }])
  }

  function showCode ({ userCode, verificationUri, expiresAt }) {
    const link = `https://www.microsoft.com/link?otc=${encodeURIComponent(userCode)}`
    const left = h('span', { class: 'muted' })
    const tick = () => {
      const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      left.textContent = `Code expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    tick()
    clearInterval(timer)
    timer = setInterval(tick, 1000)
    const copyBtn = h('button', { class: 'btn ghost small', onclick: async () => { await api.call('copyText', userCode); copyBtn.lastChild.textContent = 'Copied'; setTimeout(() => { copyBtn.lastChild.textContent = 'Copy code' }, 1500) } }, icon('copy', 13), h('span', { text: 'Copy code' }))
    m.setBody(h('div', { class: 'signin' },
      h('ol', { class: 'steps' },
        h('li', {}, h('span', { text: 'Open ' }), h('b', { text: 'microsoft.com/link' }), h('span', { text: ' in your browser (button below).' })),
        h('li', {}, h('span', { text: 'Enter this code:' })),
        h('div', { class: 'code-box' }, h('code', { class: 'device-code', text: userCode }), copyBtn),
        h('li', {}, h('span', { text: 'Sign in with the account you want to add, then come back here.' }))),
      h('div', { class: 'waiting-row' }, h('div', { class: 'spinner small' }), h('span', { text: 'Waiting for you to finish signing in…' }), left),
      h('p', { class: 'signin-tip' }, icon('alert', 13), h('span', { text: 'Adding another account? If the page signs you straight into an account you already added, copy the code, open a private window (Ctrl+Shift+N in Edge or Chrome), go to microsoft.com/link there and sign in with the other account.' })),
      h('p', { class: 'fineprint', text: `Only enter this code on ${verificationUri.replace(/^https?:\/\//, '')}. Never share it with anyone.` })))
    m.setActions([
      { label: 'Cancel', kind: 'ghost', onClick: ({ close }) => close() },
      { label: 'Open microsoft.com/link', kind: 'primary', icon: 'external', onClick: () => api.call('openExternal', link) }
    ])
  }

  function done (account) {
    clearInterval(timer)
    flowId = null
    m.setBody(h('div', { class: 'signin center' },
      h('div', { class: 'success-badge' }, icon('check', 30)),
      h('h3', { text: `${account.name} is ready` }),
      h('p', { class: 'muted', text: app.state.secureStorage.available
        ? 'Its sign-in is saved on this PC (encrypted), so you won\'t need to sign in again after a restart. Select it in the account list and press Connect.'
        : 'Select it in the account list and press Connect. This system has no secure storage, so you\'ll sign in again after restarting MineDeck.' })))
    m.setActions([
      { label: 'Add another', kind: 'ghost', icon: 'plus', onClick: () => { m.setBody(intro()); m.setActions([{ label: 'Cancel', kind: 'ghost', onClick: ({ close }) => close() }, { label: 'Start sign-in', kind: 'primary', icon: 'key', onClick: () => start() }]) } },
      { label: 'Done', kind: 'primary', onClick: ({ close }) => close() }
    ])
    app.selectAccount(account.id, true)
  }

  function failed (message) {
    clearInterval(timer)
    flowId = null
    m.setBody(h('div', { class: 'signin center' },
      h('div', { class: 'error-badge' }, icon('alert', 28)),
      h('p', { text: message })))
    m.setActions([
      { label: 'Close', kind: 'ghost', onClick: ({ close }) => close() },
      { label: 'Try again', kind: 'primary', icon: 'refresh', onClick: () => start() }
    ])
  }

  async function start () {
    waiting()
    if (unsub) unsub()
    unsub = api.onEvent((msg) => {
      if (msg.type !== 'signin' || msg.payload.flowId !== flowId) return
      const p = msg.payload
      if (p.stage === 'code') showCode(p)
      else if (p.stage === 'done') done(p.account)
      else if (p.stage === 'error') { if (p.message !== 'Sign-in cancelled') failed(p.message) }
    })
    try {
      const res = await api.call('addAccount')
      flowId = res.flowId
    } catch (e) {
      failed(e.message)
    }
  }
}

// ------------------------------------------------------------------ server editor
export function serverDialog (app, existing) {
  const s = existing || { name: '', host: '', port: 25565, version: 'auto', joinCommands: [] }
  const address = h('input', { class: 'input', placeholder: 'play.example.com or 123.45.67.89:25566', value: existing ? `${s.host}${s.port !== 25565 ? ':' + s.port : ''}` : '', autofocus: true, spellcheck: 'false' })
  const name = h('input', { class: 'input', placeholder: 'Optional, e.g. My Factions Server', value: s.name || '', maxlength: 40 })
  const version = versionSelect(app.state.versions, s.version)
  const commands = h('textarea', { class: 'input mono', rows: 4, placeholder: '/afk\n/warp afk', spellcheck: 'false' })
  commands.value = (s.joinCommands || []).join('\n')
  const pingOut = h('div', { class: 'ping-card', hidden: true })
  const error = h('div', { class: 'form-error', hidden: true })

  const doPing = async () => {
    pingOut.hidden = false
    clear(pingOut).appendChild(h('div', { class: 'row' }, h('div', { class: 'spinner small' }), h('span', { class: 'muted', text: 'Pinging…' })))
    try {
      const r = await api.call('pingServer', address.value)
      clear(pingOut).appendChild(pingCard(r))
      if (version.value === 'auto' && !r.matchedVersion) {
        error.hidden = false
        error.textContent = `Auto-detect can't match ${r.versionName || 'this server'}. Pick a version manually.`
      }
    } catch (e) {
      clear(pingOut).appendChild(h('div', { class: 'row error-text' }, icon('alert', 14), h('span', { text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })))
    }
  }

  const body = h('div', { class: 'form' },
    field('Server address', address, 'The address you type in Minecraft\'s multiplayer menu.'),
    field('Name', name),
    field('Minecraft version', version, 'Auto-detect asks the server which version it runs. Pick one if the server allows several versions.'),
    field('Commands to run after joining', commands, app.state.secureStorage.available
      ? 'One per line, run in order a couple of seconds apart (for example /login or /afk). Saved encrypted on this PC.'
      : 'One per line, run in order a couple of seconds apart (for example /afk). This system has no secure storage, so they are saved as plain text: don\'t put passwords here.'),
    h('button', { class: 'btn ghost small', type: 'button', onclick: doPing }, icon('signal', 13), 'Test connection'),
    pingOut,
    error)

  const save = async ({ close }) => {
    error.hidden = true
    try {
      const res = await api.call('saveServer', { id: existing?.id, address: address.value, name: name.value, version: version.value, joinCommands: commands.value.split('\n') })
      if (!existing) await api.call('selectServer', res.id)
      close()
      app.onServerSaved(res.id, existing)
    } catch (e) {
      error.hidden = false
      error.textContent = cleanError(e)
    }
  }
  const actions = []
  if (existing) {
    actions.push({
      label: 'Delete',
      kind: 'danger ghost',
      icon: 'trash',
      onClick: async ({ close }) => {
        if (await confirmDialog({ title: 'Delete server?', message: `Remove ${s.name || s.host} from your server list? Accounts already online stay connected.`, confirmLabel: 'Delete', danger: true })) {
          await api.call('deleteServer', existing.id)
          close()
        }
      }
    })
  }
  actions.push({ label: 'Cancel', kind: 'ghost', onClick: ({ close }) => close() })
  actions.push({ label: existing ? 'Save' : 'Add server', kind: 'primary', onClick: save })
  const m = openModal({ title: existing ? 'Edit server' : 'Add a server', body, actions })
  address.addEventListener('keydown', (e) => { if (e.key === 'Enter') save({ close: m.close }) })
}

export function versionSelect (versions, value) {
  const sel = h('select', { class: 'input' })
  sel.appendChild(h('option', { value: 'auto', text: 'Auto-detect' }))
  const groups = new Map()
  for (const v of versions) {
    const major = v.id.split('.').slice(0, 2).join('.')
    const label = /^\d{2}\./.test(v.id) ? `${major}.x` : `${major}.x`
    if (!groups.has(label)) groups.set(label, h('optgroup', { label }))
    groups.get(label).appendChild(h('option', { value: v.id, text: v.id }))
  }
  for (const g of groups.values()) sel.appendChild(g)
  sel.value = value || 'auto'
  if (!sel.value) sel.value = 'auto'
  return sel
}

export function pingCard (r) {
  return h('div', { class: 'ping-result' },
    r.favicon ? h('img', { class: 'favicon', src: r.favicon, alt: '' }) : h('div', { class: 'favicon placeholder' }, icon('server', 20)),
    h('div', { class: 'ping-info' },
      h('div', { class: 'motd' }, renderSegments(r.motdSegments, r.motd)),
      h('div', { class: 'ping-meta' },
        h('span', { text: `${r.players.online}/${r.players.max} players` }),
        h('span', { text: r.versionName || `protocol ${r.protocol}` }),
        h('span', { text: `${r.latency} ms` }),
        r.matchedVersion ? h('span', { class: 'ok', text: `joins as ${r.matchedVersion}` }) : h('span', { class: 'warn', text: 'pick a version manually' }))))
}

function field (label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    control,
    hint ? h('span', { class: 'field-hint', text: hint }) : null)
}

export function cleanError (e) {
  return String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ------------------------------------------------------------------ settings
export function settingsDialog (app) {
  const current = { ...app.state.settings }
  // changes made in quick succession are collected and saved together
  const pending = {}
  const push = debounce(async () => {
    const patch = { ...pending }
    for (const k of Object.keys(patch)) delete pending[k]
    if (!Object.keys(patch).length) return
    try {
      app.onSettings(await api.call('updateSettings', patch))
    } catch (e) {
      app.toast(cleanError(e), { kind: 'error' })
    }
  }, 250)
  const set = (key, value) => {
    pending[key] = value
    current[key] = value
    push()
  }

  const num = (key, { min, max, step = 1, suffix }) => {
    const input = h('input', { class: 'input num', type: 'number', min, max, step, value: current[key] })
    input.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, Number(input.value)))
      if (Number.isFinite(v)) { input.value = v; set(key, v) }
    })
    return h('span', { class: 'num-wrap' }, input, suffix ? h('span', { class: 'suffix', text: suffix }) : null)
  }
  const switches = {}
  const toggle = (key) => {
    const input = h('input', { type: 'checkbox', class: 'switch', checked: !!current[key] })
    input.addEventListener('change', () => {
      set(key, input.checked)
      // starting with Windows is most useful together with reconnecting on startup
      if (key === 'launchAtLogin' && input.checked && !current.resumeOnStart) {
        app.toast('MineDeck will start when you sign in. Reconnect your accounts automatically too?', {
          action: { label: 'Yes, reconnect them', onClick: () => { set('resumeOnStart', true); if (switches.resumeOnStart) switches.resumeOnStart.checked = true } }
        })
      }
    })
    switches[key] = input
    return input
  }
  const select = (key, options) => {
    const sel = h('select', { class: 'input' }, options.map(([v, t]) => h('option', { value: v, text: t })))
    sel.value = current[key]
    sel.addEventListener('change', () => set(key, sel.value))
    return sel
  }
  const words = (key, placeholder) => {
    const ta = h('textarea', { class: 'input mono', rows: 3, placeholder, spellcheck: 'false' })
    ta.value = (current[key] || []).join('\n')
    ta.addEventListener('change', () => set(key, ta.value.split('\n').map(x => x.trim()).filter(Boolean)))
    return ta
  }
  const row = (label, control, hint) => h('div', { class: 'setting' },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label', text: label }), hint ? h('div', { class: 'setting-hint', text: hint }) : null),
    h('div', { class: 'setting-control' }, control))

  const sections = [
    ['Connecting', [
      row('Delay between logins', num('loginDelaySec', { min: 0, max: 600, suffix: 'sec' }), 'Accounts log in one at a time with this gap, so the server isn\'t hit all at once.'),
      row('Extra random delay', num('loginJitterSec', { min: 0, max: 120, suffix: 'sec' }), 'Adds 0 to this many seconds on top, so logins look less robotic.'),
      row('Give up joining after', num('connectTimeoutSec', { min: 5, max: 120, suffix: 'sec' })),
      row('Auto-reconnect', toggle('autoReconnect'), 'Reconnect automatically after a kick, crash or lost connection.'),
      row('First retry after', num('reconnectDelaySec', { min: 1, max: 3600, suffix: 'sec' }), 'Each failed retry doubles the wait, up to the maximum below.'),
      row('Longest wait between retries', num('reconnectMaxDelaySec', { min: 1, max: 86400, suffix: 'sec' })),
      row('Stop after this many retries', num('reconnectMaxAttempts', { min: 0, max: 10000 }), '0 = never give up.'),
      row("Don't reconnect if the kick message contains", words('reconnectStopWords', 'banned\nwhitelist'), 'One per line. Stops reconnect loops when you\'re banned or logged in somewhere else.'),
      row('Reconnect accounts on startup', toggle('resumeOnStart'), 'When MineDeck opens, reconnect the accounts that were online when it closed.')
    ]],
    ['In game', [
      row('Respawn automatically', toggle('autoRespawn')),
      row('Accept server resource packs', toggle('acceptResourcePacks'), 'Some servers kick players who decline. Nothing is downloaded; MineDeck only answers the server.'),
      row('Anti-AFK', select('antiAfk', [['off', 'Off'], ['swing', 'Swing arm'], ['look', 'Look around'], ['jump', 'Jump'], ['sneak', 'Sneak']]), 'Small periodic action so servers don\'t kick for being idle. Check your server\'s rules first.'),
      row('Anti-AFK every', num('antiAfkIntervalSec', { min: 5, max: 3600, suffix: 'sec' })),
      row('View distance', select('viewDistance', [['tiny', 'Tiny (lightest)'], ['short', 'Short'], ['normal', 'Normal'], ['far', 'Far']]), 'Lower uses less memory and bandwidth per account.'),
      row('Gap between join commands', num('joinCommandDelaySec', { min: 0, max: 60, suffix: 'sec' }))
    ]],
    ['Chat', [
      row('Gap between accounts when sending', num('sendDelayMs', { min: 0, max: 10000, step: 50, suffix: 'ms' }), 'When one message goes out from several accounts, space them out to avoid spam kicks.'),
      row('Merge identical messages', toggle('chatMergeDuplicates'), 'When several accounts see the same message, show it once with a ×count.'),
      row('Show timestamps', toggle('chatTimestamps')),
      row('Show connection events', toggle('chatShowEvents'), 'Joins, kicks and reconnects, shown in grey.'),
      row('Show action bar messages', toggle('chatShowActionBar')),
      row('Highlight these words', words('highlightWords', 'your name\nnickname'), 'Your account names are always highlighted.'),
      row('Flash the taskbar when mentioned', toggle('notifyOnMention')),
      row('Lines to keep', num('chatMaxLines', { min: 200, max: 50000, step: 100 })),
      row('Save chat logs to this PC', toggle('saveChatLogs'), 'Plain text files in MineDeck\'s data folder. Off by default.'),
      row('Chat log folder', h('button', { class: 'btn ghost small', onclick: () => api.call('openLogsFolder') }, icon('folder', 13), 'Open'))
    ]],
    ['App', [
      app.state.canLaunchAtLogin
        ? row(`Start MineDeck when you sign in to ${app.state.platform === 'darwin' ? 'your Mac' : 'Windows'}`, toggle('launchAtLogin'),
          'Starts in the background (in the tray if the option below is on). Turn on "Reconnect accounts on startup" as well, and your accounts come back online by themselves after a restart.')
        : null,
      row('Close button minimizes to tray', toggle('minimizeToTray'), 'Keeps accounts connected in the background. Quit from the tray icon.'),
      row('Keep the PC awake while accounts are online', toggle('keepAwake'), 'Stops Windows from sleeping and dropping connections.'),
      app.state.platform === 'win32'
        ? row('Shortcuts', h('button', {
          class: 'btn ghost small',
          onclick: async () => {
            const r = await api.call('createShortcuts')
            app.toast(r.ok ? 'Added MineDeck to your desktop and Start menu.' : (r.reason || 'Could not create shortcuts.'), { kind: r.ok ? 'info' : 'warn' })
          }
        }, icon('plus', 13), 'Add to desktop & Start menu'), 'Creates shortcuts with the MineDeck icon.')
        : null
    ].filter(Boolean)]
  ]

  const nav = h('nav', { class: 'settings-nav' })
  const content = h('div', { class: 'settings-content' })
  sections.forEach(([title, rows], i) => {
    const id = `set-${i}`
    const sec = h('section', { id }, h('h3', { text: title }), rows)
    content.appendChild(sec)
    nav.appendChild(h('button', { class: 'nav-item', onclick: () => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, title))
  })
  nav.appendChild(h('button', { class: 'nav-item', onclick: () => { m.close(); privacyDialog(app) } }, 'Privacy & data'))
  const m = openModal({ title: 'Settings', subtitle: 'Changes save automatically.', body: h('div', { class: 'settings' }, nav, content), wide: true, actions: [] })
}

// ------------------------------------------------------------------ privacy
const BACKENDS = {
  dpapi: 'Windows (DPAPI)',
  keychain: 'the macOS Keychain',
  gnome_libsecret: 'your GNOME keyring',
  kwallet: 'KWallet',
  kwallet5: 'KWallet',
  kwallet6: 'KWallet'
}

export function privacyDialog (app) {
  const st = app.state.secureStorage
  const body = h('div', { class: 'privacy' },
    h('div', { class: `secure-card ${st.available ? 'ok' : 'warn'}` },
      icon(st.available ? 'shield' : 'alert', 22),
      h('div', {},
        h('b', { text: st.available ? 'Sign-ins are encrypted on this PC' : 'No secure storage on this system' }),
        h('p', { text: st.available
          ? `Account tokens are encrypted by ${BACKENDS[st.backend] || 'your operating system'}. Only your user account on this computer can unlock them.`
          : 'Your system has no keyring, so sign-ins are kept in memory only and never written to disk. You\'ll need to sign in again after restarting MineDeck.' }))),
    h('h3', { text: 'What MineDeck stores' }),
    h('ul', { class: 'facts' },
      h('li', { text: 'Account names, UUIDs and encrypted sign-in tokens' }),
      h('li', { text: 'Your server list, settings and window size' }),
      h('li', { text: 'Skin images (for the account list) and, only if you turn it on, chat logs' })),
    h('h3', { text: 'Who MineDeck talks to' }),
    h('ul', { class: 'facts' },
      h('li', { text: 'Microsoft, Xbox Live and Mojang, to sign in and load skins' }),
      h('li', { text: 'The Minecraft servers you connect to' }),
      h('li', { text: 'Nobody else: no analytics, no tracking, no update checks. The app\'s author never receives anything.' })),
    h('div', { class: 'data-path' }, h('span', { class: 'muted', text: 'Data folder: ' }), h('code', { text: app.state.dataDir })),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn ghost small', onclick: () => api.call('openDataFolder') }, icon('folder', 13), 'Open data folder'),
      app.state.homepage ? h('button', { class: 'btn ghost small', onclick: () => api.call('openExternal', app.state.homepage) }, icon('external', 13), 'Source code') : null,
      h('button', {
        class: 'btn danger ghost small',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Remove all accounts and delete data?', message: 'Disconnects every account and permanently deletes all saved sign-ins, skins and chat logs from this PC. Your servers and settings are kept.', confirmLabel: 'Delete everything', danger: true, typeToConfirm: 'DELETE' })
          if (ok) { await api.call('wipeAllData', 'DELETE'); app.toast('All accounts and sign-ins were deleted.') }
        }
      }, icon('trash', 13), 'Remove all accounts & data')))
  openModal({ title: 'Privacy & data', body, actions: [{ label: 'Close', kind: 'primary', onClick: ({ close }) => close() }] })
}
