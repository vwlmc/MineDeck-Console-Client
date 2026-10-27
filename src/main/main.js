'use strict'
/*
 * MineDeck, made by vwl.
 * Main process.
 *
 * Security model (see SECURITY.md):
 *  - The window is sandboxed with context isolation and no Node.js access.
 *    It can only call the small list of functions in API below, and every
 *    argument is validated here.
 *  - Account tokens never leave this process except to Microsoft / Xbox /
 *    Mojang. The window only ever receives names, UUIDs and status.
 *  - The window only loads MineDeck's own files (minedeck://app/) under a strict
 *    Content-Security-Policy; it never loads remote web pages.
 *  - No telemetry, analytics or update checks. MineDeck only talks to:
 *    Microsoft / Xbox Live / Mojang (sign-in, skins) and the game servers you pick.
 */
const { app, BrowserWindow, ipcMain, protocol, session, shell, clipboard, Tray, Menu, nativeImage, powerSaveBlocker, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { JsonFile } = require('./store')
const { AccountStore } = require('./accounts')
const { Manager } = require('./manager')
const { DEFAULT_SETTINGS, applySettingsPatch, cleanServer, parseAddress } = require('./settings')
const { listVersions } = require('./versions')
const { getSkin } = require('./skins')
const { ChatLog } = require('./chatlog')
const secure = require('./secure-store')
const { createJoinCommandsVault } = require('./join-commands-vault')
const { PovHost } = require('./pov')
const { MacroEngine } = require('./macro-engine')
const { openMacroStore } = require('./macro-store')
const macroLib = require('./macros')
const joinCommandsVault = createJoinCommandsVault(secure)

const APP_ID = 'app.minedeck.client'
const SCHEME = 'minedeck'
const ORIGIN = `${SCHEME}://app`
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js')
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png')
// PNGs (not .ico): Windows loads .ico files straight from disk, which can't
// see inside the app.asar archive. tray@1.5x.png / tray@2x.png cover high-DPI.
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'tray.png')
const AUTHOR = (() => {
  try {
    const author = require('../../package.json').author
    return typeof author === 'string' ? author.slice(0, 60) : null
  } catch { return null }
})()
const HOMEPAGE = (() => {
  try {
    const url = require('../../package.json').homepage
    return typeof url === 'string' && /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(url) ? url : null
  } catch { return null }
})()
const DEVTOOLS = process.argv.includes('--devtools') || process.env.MINEDECK_DEVTOOLS === '1'
// passed by the "start when you sign in" entry, so MineDeck starts in the background
const AUTOSTART_ARG = '--autostart'
const launchedAtLogin = process.argv.includes(AUTOSTART_ARG)
// accounts in these states are "meant to be online" and are reconnected on startup
const WANTED_ONLINE = new Set(['online', 'waiting', 'queued', 'signing_in', 'connecting', 'logging_in'])

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

// links the UI may open in the user's browser
const EXTERNAL_ALLOW = [
  /^https:\/\/(www\.)?microsoft\.com\/link(\?otc=[A-Z0-9-]{1,20})?$/i,
  /^https:\/\/www\.minecraft\.net\/[\w\-/]*$/i,
  /^https:\/\/account\.microsoft\.com\/[\w\-/]*$/i,
  /^https:\/\/github\.com\/[\w-]+\/[\w.-]+(\/[\w\-/.]*)?$/i
]

app.setName('MineDeck')
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
// optional: keep MineDeck's data somewhere else (for example on a USB drive)
if (process.env.MINEDECK_DATA_DIR && path.isAbsolute(process.env.MINEDECK_DATA_DIR)) {
  app.setPath('userData', process.env.MINEDECK_DATA_DIR)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }])
  app.on('second-instance', () => showWindow())
  app.whenReady().then(start).catch(err => {
    console.error(err)
    dialog.showErrorBox('MineDeck could not start', String(err && err.stack ? err.stack : err))
    app.exit(1)
  })
}

let win = null
let tray = null
let quitting = false
let config = null
let accounts = null
let manager = null
let chatLog = null
let povHost = null
let macroStore = null
let macroEngine = null
let powerBlockId = null
let startInBackground = launchedAtLogin
let resumeTracking = false // true once any startup reconnect has been queued
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' }

process.on('uncaughtException', (err) => console.error('[uncaught]', err))
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))

function dataDir () {
  return app.getPath('userData')
}

function settings () {
  return config?.data?.settings || DEFAULT_SETTINGS
}

function currentServer () {
  const s = config.data.servers.find(x => x.id === config.data.selectedServerId)
  return s || null
}

function send (type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('minedeck:evt', { type, payload })
}

// ---------------------------------------------------------------- startup
async function start () {
  hardenSessions()
  registerProtocol()

  const dir = dataDir()
  config = new JsonFile(path.join(dir, 'config.json'), {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    servers: [],
    selectedServerId: null,
    resumeAccounts: [],
    window: null
  }, joinCommandsVault)
  config.load()
  config.data.settings = applySettingsPatch(config.data.settings, {})
  config.data.servers = (Array.isArray(config.data.servers) ? config.data.servers : []).flatMap(s => {
    try { return [{ id: typeof s.id === 'string' ? s.id : newId('srv'), ...cleanServer(s) }] } catch { return [] }
  })
  if (!Array.isArray(config.data.resumeAccounts)) config.data.resumeAccounts = []

  accounts = new AccountStore(dir)
  accounts.load()
  accounts.on('changed', () => send('accounts', accounts.publicList()))

  chatLog = new ChatLog(path.join(dir, 'logs'))
  manager = new Manager({ accounts, getSettings: settings, getServer: currentServer })
  manager.on('slots', (slots) => {
    send('slots', { slots, queue: manager.queueInfo() })
    updateKeepAwake()
    updateTray()
    rememberOnlineAccounts()
  })
  manager.on('lines', (lines) => send('lines', lines))
  manager.on('menu', (id, title) => send('menu', { id, title }))
  povHost = new PovHost(manager, (payload) => send('pov', payload))

  // macros: saved encrypted in macros.json, run by the engine next to the connections
  macroStore = openMacroStore(dir, secure)
  macroEngine = new MacroEngine({
    manager,
    accounts,
    getMacros: () => macroStore.data.macros,
    onDisable: (id, reason) => {
      const m = macroStore.data.macros.find(x => x.id === id)
      if (!m) return
      m.enabled = false
      macroStore.save()
      sendMacros()
      send('macroNotify', { macro: m.name, text: `Its automatic start was switched off: ${reason}.`, warn: true })
    }
  })
  macroEngine.on('runs', (runs) => send('macroRuns', runs))
  macroEngine.on('log', (entry) => {
    send('macroLog', entry)
    if (entry.level === 'warn' || entry.level === 'error' || entry.level === 'notify') {
      manager.note(entry.acc, `${entry.name}: [${entry.macro}] ${entry.text}`, entry.level === 'notify' ? 'good' : entry.level)
    }
  })
  macroEngine.on('notify', (entry) => {
    send('macroNotify', entry)
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
  })
  manager.on('line', (line) => {
    if (settings().saveChatLogs) chatLog.write(line)
    if (line.kind === 'chat' && settings().notifyOnMention && win && !win.isFocused() && mentionsMe(line.text)) {
      win.flashFrame(true)
    }
  })

  ipcMain.handle('minedeck:call', handleCall)
  createWindow()

  if (settings().minimizeToTray) ensureTray()
  applyLoginItem() // keeps the "start when you sign in" entry pointing at this copy of MineDeck

  // optionally reconnect accounts that were online when MineDeck last closed
  const resume = config.data.resumeAccounts.filter(id => accounts.get(id))
  if (settings().resumeOnStart && resume.length && currentServer()) {
    setTimeout(() => {
      manager.connect(resume)
      resumeTracking = true
    }, 1500)
  } else {
    resumeTracking = true
  }
}

function wantedOnline () {
  return [...manager.slots.values()].filter(s => WANTED_ONLINE.has(s.status)).map(s => s.id).sort()
}

// Keep the list of accounts to reconnect up to date while MineDeck runs, so it
// is right even when Windows restarts the PC without letting MineDeck close normally.
function rememberOnlineAccounts () {
  if (!resumeTracking || quitting) return
  const ids = wantedOnline()
  const prev = [...config.data.resumeAccounts].sort()
  if (ids.length === prev.length && ids.every((id, i) => id === prev[i])) return
  config.data.resumeAccounts = ids
  config.save()
}

// The program to start: for electron-builder's portable .exe this is the file
// the user downloaded, not the temporary copy it runs from.
function appExecutable () {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  return portable && path.isAbsolute(portable) && /\.exe$/i.test(portable) ? portable : process.execPath
}

function canLaunchAtLogin () {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
}

// "Start MineDeck when you sign in": a normal per-user startup entry
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Run on Windows) that only holds the path to MineDeck.
function applyLoginItem () {
  if (!canLaunchAtLogin()) return
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings().launchAtLogin, path: appExecutable(), args: [AUTOSTART_ARG] })
  } catch (e) {
    console.error('[login item]', e.message)
  }
}

function newId (prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

// same rule as the window: ignore the author part of the line ("<Name> ", "Name: ")
function mentionsMe (text) {
  const m = text.match(/^(.{0,48}?)(?:> |: | » | > )/)
  const body = (m ? text.slice(m[0].length) : text).toLowerCase()
  const words = [...accounts.accounts.map(a => a.name), ...(settings().highlightWords || [])]
  return words.some(w => w && w.length >= 3 && body.includes(w.toLowerCase()))
}

// ---------------------------------------------------------------- security
function hardenSessions () {
  const ses = session.defaultSession
  // Chromium's spellchecker would otherwise download dictionaries from Google
  // at startup. MineDeck doesn't spellcheck, so point the download at an
  // address that never leaves this app (it simply fails) and switch it off.
  try {
    ses.setSpellCheckerDictionaryDownloadURL(`${SCHEME}://no-dictionaries/`)
    ses.setSpellCheckerEnabled(false)
  } catch { }
  // the only permission MineDeck's page gets: locking the mouse pointer in the POV view
  const ownPage = (url) => typeof url === 'string' && url.startsWith(`${ORIGIN}/`)
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(permission === 'pointerLock' && ownPage(details?.requestingUrl || wc.getURL())))
  ses.setPermissionCheckHandler((wc, permission, origin) => permission === 'pointerLock' && (ownPage(`${origin}/`) || ownPage(wc?.getURL())))
  ses.setDevicePermissionHandler?.(() => false)
  // the UI never fetches anything from the network
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith(`${ORIGIN}/`) || details.url.startsWith('data:') || details.url.startsWith('devtools://')
    cb({ cancel: !ok })
  })
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.on('will-navigate', (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault() })
    contents.on('will-redirect', (e, url) => { if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault() })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

function registerProtocol () {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 })
      let rel = decodeURIComponent(url.pathname)
      if (rel === '/' || rel === '') rel = '/index.html'
      const file = path.normalize(path.join(RENDERER_DIR, rel))
      if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 })
      const body = await fs.promises.readFile(file)
      return new Response(body, {
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// ---------------------------------------------------------------- window
function createWindow () {
  const bounds = config.data.window || {}
  win = new BrowserWindow({
    width: clamp(bounds.width, 960, 4000, 1280),
    height: clamp(bounds.height, 600, 3000, 820),
    x: Number.isInteger(bounds.x) ? bounds.x : undefined,
    y: Number.isInteger(bounds.y) ? bounds.y : undefined,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1115',
    title: 'MineDeck',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: DEVTOOLS || !app.isPackaged,
      backgroundThrottling: false
    }
  })
  if (process.platform !== 'darwin') win.setMenu(null)
  if (bounds.maximized) win.maximize()
  // right-click menu for copying chat and editing text boxes
  win.webContents.on('context-menu', (_e, params) => {
    let items = []
    if (params.isEditable) {
      items = [
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    } else if (params.selectionText && params.selectionText.trim()) {
      items = [{ role: 'copy' }]
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
  // started by "start when you sign in": stay in the tray, or start minimized
  const background = startInBackground
  startInBackground = false
  win.once('ready-to-show', () => {
    if (!background) win.show()
    else if (settings().minimizeToTray) ensureTray()
    else win.minimize()
  })
  // Windows is shutting down, restarting or signing out: save everything now
  win.on('session-end', () => {
    quitting = true
    try {
      if (resumeTracking) config.data.resumeAccounts = wantedOnline()
      saveWindowBounds()
      config.saveNow()
      macroStore.flush()
      accounts.flush()
      chatLog.flush()
    } catch (e) {
      console.error('[session-end]', e)
    }
  })
  win.on('focus', () => win.flashFrame(false))
  win.on('close', (e) => {
    saveWindowBounds()
    if (!quitting && settings().minimizeToTray) {
      e.preventDefault()
      ensureTray()
      win.hide()
    }
  })
  win.on('closed', () => { win = null; povHost?.close() })
  win.loadURL(`${ORIGIN}/index.html`)
}

function clamp (v, min, max, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt
}

function saveWindowBounds () {
  if (!win || win.isDestroyed()) return
  const b = win.getNormalBounds()
  config.data.window = { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() }
  config.save()
}

function showWindow () {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function ensureTray () {
  if (tray) return
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
    tray.setToolTip('MineDeck')
    tray.on('click', showWindow)
    updateTray()
  } catch (e) {
    console.error('[tray]', e.message)
  }
}

function updateTray () {
  if (!tray) return
  const online = manager.onlineCount()
  tray.setToolTip(`MineDeck: ${online} online`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${online} account${online === 1 ? '' : 's'} online`, enabled: false },
    { type: 'separator' },
    { label: 'Show MineDeck', click: showWindow },
    { label: 'Disconnect all', click: () => manager.disconnectAll(), enabled: online > 0 },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit() } }
  ]))
}

function updateKeepAwake () {
  const want = settings().keepAwake && manager.onlineCount() > 0
  if (want && powerBlockId === null) powerBlockId = powerSaveBlocker.start('prevent-app-suspension')
  if (!want && powerBlockId !== null) {
    powerSaveBlocker.stop(powerBlockId)
    powerBlockId = null
  }
}

let shutDown = false
app.on('before-quit', () => {
  quitting = true
  if (shutDown || !config || !manager) return
  shutDown = true
  try {
    povHost?.close()
    macroEngine?.shutdown()
    // remember what was online before the connections are closed
    if (resumeTracking) config.data.resumeAccounts = wantedOnline()
    saveWindowBounds()
    manager.shutdown()
    config.flush()
    config.saveNow()
    macroStore.flush()
    accounts.flush()
    chatLog.flush()
  } catch (e) {
    console.error('[quit]', e)
  }
})

app.on('window-all-closed', () => {
  if (!settings()?.minimizeToTray || quitting) app.quit()
})

app.on('activate', () => showWindow())

// ---------------------------------------------------------------- API for the window
const ID_RE = /^[a-z]{3}_[0-9a-f]{12}$/
const isId = (v) => typeof v === 'string' && ID_RE.test(v)
function ids (v) {
  if (!Array.isArray(v)) throw new Error('expected a list of accounts')
  return [...new Set(v.filter(isId))].slice(0, 500)
}
function str (v, max) {
  if (typeof v !== 'string') throw new Error('expected text')
  return v.slice(0, max)
}

function macroState () {
  return {
    macros: macroStore.data.macros,
    runs: macroEngine.publicRuns(),
    log: macroEngine.logLines.slice(-200),
    templates: macroLib.TEMPLATES.map(({ key, title, description }) => ({ key, title, description })),
    encrypted: secure.isAvailable()
  }
}

function sendMacros () {
  send('macros', macroStore.data.macros)
}

function addMacro (m) {
  if (macroStore.data.macros.length >= macroLib.MAX_MACROS) throw new Error(`You can save up to ${macroLib.MAX_MACROS} macros.`)
  macroStore.data.macros.push(m)
  macroStore.save()
  sendMacros()
  return m
}

function stateSnapshot () {
  return {
    appVersion: app.getVersion(),
    author: AUTHOR,
    homepage: HOMEPAGE,
    platform: process.platform,
    canLaunchAtLogin: canLaunchAtLogin(),
    dataDir: dataDir(),
    secureStorage: { available: secure.isAvailable(), backend: secure.backend() },
    accounts: accounts.publicList(),
    slots: manager.publicSlots(),
    queue: manager.queueInfo(),
    settings: settings(),
    servers: config.data.servers,
    selectedServerId: config.data.selectedServerId,
    versions: listVersions().map(v => ({ id: v.id, engine: v.engine })),
    history: manager.history.slice(-2000)
  }
}

const API = {
  getState: () => stateSnapshot(),

  // ---- accounts
  addAccount: () => {
    const flowId = newId('sig')
    accounts.signIn(flowId, (code) => send('signin', { stage: 'code', ...code }))
      .then(acc => send('signin', { stage: 'done', flowId, account: acc }))
      .catch(e => send('signin', { stage: 'error', flowId, message: e.message || 'Sign-in failed' }))
    return { flowId }
  },
  cancelAddAccount: (flowId) => { if (isId(flowId)) accounts.cancelSignIn(flowId); return true },
  removeAccount: (id) => {
    if (!isId(id)) return false
    if (povHost.id === id) povHost.close()
    macroEngine.stop({ accountId: id })
    let changed = false
    for (const m of macroStore.data.macros) {
      if (Array.isArray(m.accounts) && m.accounts.includes(id)) { m.accounts = m.accounts.filter(a => a !== id); changed = true }
    }
    if (changed) { macroStore.save(); sendMacros() }
    manager.forget(id)
    return accounts.remove(id)
  },
  moveAccount: (id, index) => { if (isId(id) && Number.isInteger(index)) accounts.move(id, index); return true },
  getSkin: async (id) => {
    if (!isId(id)) return null
    const acc = accounts.get(id)
    if (!acc) return null
    return getSkin(path.join(dataDir(), 'skins'), acc.uuid, accounts.skinUrl(id))
  },

  // ---- connections
  connect: (list) => manager.connect(ids(list)),
  disconnect: (list) => { manager.disconnect(ids(list)); return true },
  reconnect: (list) => manager.reconnect(ids(list)),
  sendChat: (text, list) => manager.sendChat(str(text, 1000), ids(list)),
  getPlayers: (id) => (isId(id) ? manager.players(id) : []),

  // ---- macros
  getMacros: () => macroState(),
  saveMacro: (input) => {
    const m = macroLib.cleanMacro(input)
    const list = macroStore.data.macros
    const i = list.findIndex(x => x.id === m.id)
    if (i === -1) {
      if (list.length >= macroLib.MAX_MACROS) throw new Error(`You can save up to ${macroLib.MAX_MACROS} macros.`)
      list.push(m)
    } else {
      list[i] = m
    }
    macroStore.save()
    sendMacros()
    return m
  },
  deleteMacro: (id) => {
    if (!isId(id)) return false
    macroEngine.stop({ macroId: id })
    macroStore.data.macros = macroStore.data.macros.filter(m => m.id !== id)
    macroStore.save()
    sendMacros()
    return true
  },
  moveMacro: (id, index) => {
    const list = macroStore.data.macros
    const i = list.findIndex(m => m.id === id)
    if (i === -1 || !Number.isInteger(index)) return false
    const [m] = list.splice(i, 1)
    list.splice(Math.max(0, Math.min(list.length, index)), 0, m)
    macroStore.save()
    sendMacros()
    return true
  },
  runMacro: (id, list) => {
    if (!isId(id)) throw new Error('unknown macro')
    return macroEngine.run(id, list == null ? null : ids(list), 'manual')
  },
  stopMacro: (id, accountId) => macroEngine.stop({ macroId: isId(id) ? id : null, accountId: isId(accountId) ? accountId : null }),
  shareMacro: (id) => {
    const m = macroStore.data.macros.find(x => x.id === id)
    if (!m) return false
    clipboard.writeText(macroLib.shareText(m))
    return true
  },
  importMacro: (input) => addMacro(macroLib.parseShared(str(input, 200000))),
  addMacroTemplate: (key) => addMacro(macroLib.fromTemplate(str(key, 40))),

  // ---- POV: watch and steer one account
  povOpen: (id) => (isId(id) ? povHost.open(id) : { ok: false, reason: 'unknown account' }),
  povClose: () => { povHost.close(); return true },
  pov: (action, a, b, c) => povHost.action(str(action, 20), a, b, c),

  // ---- servers
  saveServer: (input) => {
    const clean = cleanServer(input)
    const id = isId(input?.id) && config.data.servers.some(s => s.id === input.id) ? input.id : newId('srv')
    const i = config.data.servers.findIndex(s => s.id === id)
    if (i === -1) {
      if (config.data.servers.length >= 100) throw new Error('You can save up to 100 servers.')
      config.data.servers.push({ id, ...clean })
    } else {
      config.data.servers[i] = { id, ...clean }
    }
    joinCommandsVault.forget(id) // the user has just set this server's commands
    if (!config.data.selectedServerId) config.data.selectedServerId = id
    config.save()
    send('servers', { servers: config.data.servers, selectedServerId: config.data.selectedServerId })
    return { id }
  },
  deleteServer: (id) => {
    if (!isId(id)) return false
    config.data.servers = config.data.servers.filter(s => s.id !== id)
    joinCommandsVault.forget(id)
    if (config.data.selectedServerId === id) config.data.selectedServerId = config.data.servers[0]?.id || null
    config.save()
    send('servers', { servers: config.data.servers, selectedServerId: config.data.selectedServerId })
    return true
  },
  selectServer: (id) => {
    if (id !== null && !(isId(id) && config.data.servers.some(s => s.id === id))) return false
    config.data.selectedServerId = id
    config.save()
    send('servers', { servers: config.data.servers, selectedServerId: id })
    return true
  },
  pingServer: async (address) => {
    const addr = parseAddress(str(address, 300))
    if (!addr) throw new Error('That server address is not valid.')
    return manager.ping(addr.host, addr.port)
  },

  // ---- settings
  updateSettings: (patch) => {
    if (!patch || typeof patch !== 'object') return settings()
    const before = settings().launchAtLogin
    config.data.settings = applySettingsPatch(settings(), patch)
    config.save()
    manager.applySettings()
    updateKeepAwake()
    if (settings().launchAtLogin !== before) applyLoginItem()
    if (settings().minimizeToTray) ensureTray()
    else if (tray) { tray.destroy(); tray = null }
    send('settings', settings())
    return settings()
  },

  // ---- misc
  copyText: (text) => { clipboard.writeText(str(text, 500)); return true },
  openExternal: (url) => {
    const u = str(url, 300)
    if (!EXTERNAL_ALLOW.some(re => re.test(u))) return false
    shell.openExternal(u)
    return true
  },
  openDataFolder: () => { shell.openPath(dataDir()); return true },
  // Windows: desktop + Start menu shortcuts that use MineDeck's icon
  createShortcuts: () => {
    if (process.platform !== 'win32') return { ok: false, reason: 'Shortcuts can only be created on Windows.' }
    // the icon is embedded in MineDeck.exe itself
    const exe = appExecutable()
    const options = { target: exe, cwd: path.dirname(exe), description: 'MineDeck - multi-account Minecraft client', icon: exe, iconIndex: 0, appUserModelId: APP_ID }
    const made = []
    for (const dir of [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')]) {
      try {
        if (shell.writeShortcutLink(path.join(dir, 'MineDeck.lnk'), 'create', options)) made.push(dir)
      } catch { }
    }
    return { ok: made.length > 0, count: made.length }
  },
  openLogsFolder: () => {
    const dir = path.join(dataDir(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    shell.openPath(dir)
    return true
  },
  wipeAllData: (confirmWord) => {
    if (confirmWord !== 'DELETE') return false
    povHost.close()
    macroEngine.stop()
    macroStore.data.macros = []
    macroStore.saveNow()
    manager.disconnectAll()
    accounts.wipe()
    for (const sub of ['skins', 'logs']) fs.rmSync(path.join(dataDir(), sub), { recursive: true, force: true })
    config.data.resumeAccounts = []
    config.saveNow()
    return true
  }
}

async function handleCall (event, method, args) {
  // only our own page may call the API
  const frameUrl = event.senderFrame?.url || ''
  if (!frameUrl.startsWith(`${ORIGIN}/`)) throw new Error('blocked')
  if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(API, method)) throw new Error('unknown call')
  if (!Array.isArray(args) || args.length > 4) throw new Error('bad arguments')
  return API[method](...args)
}
