'use strict'
// End-to-end test of the real Electron app with Playwright.
// usage: node test/e2e/ui.e2e.js <electron-binary> <screenshot-dir>
const path = require('path')
const fs = require('fs')
const os = require('os')
const { _electron: electron } = require('playwright')
const { startFakeServer } = require('../helpers/fake-server')

const [electronBin, shots] = process.argv.slice(2)
const appDir = path.join(__dirname, 'app')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function waitUntil (fn, ms, label) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

async function main () {
  fs.mkdirSync(shots, { recursive: true })
  const srv = await startFakeServer({ version: '1.20.4', motd: '§aMineDeck §7Test §6Server', world: true })
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minedeck-e2e-'))
  const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) } catch { return {} } }
  const errors = []
  const launch = async () => {
    const app = await electron.launch({
      executablePath: electronBin,
      args: [appDir, '--no-sandbox'],
      env: {
        ...process.env,
        MINEDECK_DATA_DIR: dataDir,
        MINEDECK_TEST_ACCOUNTS: 'Alpha,Bravo,Charlie'
      }
    })
    const win = await app.firstWindow()
    win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`) })
    win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await win.setViewportSize({ width: 1360, height: 840 })
    return { app, win }
  }
  const { app, win } = await launch()
  await win.waitForSelector('.account')
  await sleep(500)
  await win.screenshot({ path: path.join(shots, '01-first-run.png') })

  // add a server through the UI
  await win.click('#server-btn')
  await win.click('text=Add a server…')
  await win.fill('.modal input.input >> nth=0', `127.0.0.1:${srv.port}`)
  await win.fill('.modal input.input >> nth=1', 'Test Server')
  await win.click('.modal >> text=Test connection')
  await win.waitForSelector('.modal .ping-result')
  await win.screenshot({ path: path.join(shots, '02-add-server.png') })
  await win.click('.modal >> text=Add server')
  await win.waitForSelector('#version-select')

  // ping chip
  await win.click('#ping-btn')
  await win.waitForSelector('.ping-chip.good')

  // select all and connect
  await win.check('#select-all')
  await win.click('#connect-sel')
  await win.waitForFunction(() => document.querySelector('#acc-count')?.textContent.startsWith('3 of 3'), null, { timeout: 30000 })
  // which accounts to bring back after a restart is saved while MineDeck runs
  await waitUntil(() => (readConfig().resumeAccounts || []).length === 3, 10000, 'online accounts to be saved')

  // server chat with colours, seen by all 3 accounts (merged into one line)
  srv.broadcast('§6[Server] §fWelcome to §aMineDeck§f! §7(§bwiki§7)')
  srv.broadcast('§cWarning: §eRestart in 5 minutes')
  await sleep(600)
  // send from the composer
  await win.fill('#chat-input', 'hello from MineDeck')
  await win.press('#chat-input', 'Enter')
  const atServer = () => srv.received.filter(r => r.message === 'hello from MineDeck').map(r => r.username).sort().join()
  await waitUntil(() => atServer() === 'Alpha,Bravo,Charlie', 10000, 'the message from all 3 accounts')
    .catch(e => { throw new Error(`${e.message} (the server got it from: ${atServer() || 'nobody'})`) })
  srv.broadcast('§d<Notch> §fhey Alpha, nice base')
  await sleep(400)
  await win.screenshot({ path: path.join(shots, '03-online-chat.png') })

  // a server's clickable "[ACCEPT]" in chat runs its command from the account that got it
  const alphaClient = Object.values(srv.server.clients).find(c => c.username === 'Alpha')
  srv.componentChat(alphaClient, { text: 'Bob wants to teleport to you. ', color: 'gold', extra: [{ text: '[ACCEPT]', color: 'green', bold: true, clickEvent: { action: 'run_command', value: '/tpaccept Bob' }, hoverEvent: { action: 'show_text', contents: { text: 'Accept the request' } } }] })
  await win.waitForSelector('.mc-click:has-text("[ACCEPT]")')
  await win.click('.mc-click:has-text("[ACCEPT]")')
  await waitUntil(() => srv.received.some(r => r.message === '/tpaccept Bob' && r.username === 'Alpha'), 5000, 'the clicked command at the server')
  if (srv.received.filter(r => r.message === '/tpaccept Bob').length !== 1) throw new Error('the clicked command should run once, from Alpha only')
  console.log('clickable chat: [ACCEPT] ran /tpaccept from Alpha')

  // only Bravo sends a command
  await win.click('.chip:has-text("Alpha") .chip-x')
  await win.click('.chip:has-text("Charlie") .chip-x')
  await win.fill('#chat-input', '/spawn')
  await win.press('#chat-input', 'Enter')
  const spawn = () => srv.received.filter(r => r.message === '/spawn').map(r => r.username).join()
  await waitUntil(() => spawn() !== '', 8000, 'the /spawn command at the server')
  await sleep(800) // room for a wrong extra copy to arrive
  if (spawn() !== 'Bravo') throw new Error('only Bravo should send /spawn, got ' + spawn())

  // kick Charlie -> reconnect countdown
  const charlie = Object.values(srv.server.clients).find(c => c.username === 'Charlie')
  charlie.end('§cYou were kicked: §7Too many packets')
  await win.waitForFunction(() => [...document.querySelectorAll('.account')].some(r => r.textContent.includes('Retry in')), null, { timeout: 8000 })
  await win.screenshot({ path: path.join(shots, '04-kick-reconnect.png') })

  // players tab
  await win.click('#tab-players')
  await sleep(1200)
  await win.screenshot({ path: path.join(shots, '05-players.png') })

  // POV: see through Bravo's eyes, answer a server menu, look around
  await win.click('#tab-pov')
  await win.selectOption('#pov-account', { label: 'Bravo' })
  await win.waitForFunction(() => document.querySelector('.pov-status')?.hidden, null, { timeout: 20000 })
  await sleep(1500)
  await win.screenshot({ path: path.join(shots, '05b-pov.png') })
  const bravo = Object.values(srv.server.clients).find(c => c.username === 'Bravo')
  await win.mouse.click(900, 480) // takes the mouse (pointer lock)
  // wait until the POV view has seen the lock too: its pointerlockchange event comes a moment
  // after document.pointerLockElement is set, and a mouse move before that isn't a look
  await win.waitForFunction(() => !!document.pointerLockElement?.classList.contains('locked'), null, { timeout: 5000 })
  await win.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 700, movementY: 0 })))
  const turned = await win.waitForFunction(() => /facing west/.test(document.querySelector('.pov-info')?.textContent || ''), null, { timeout: 5000 }).then(() => true, () => false)
  if (!turned) throw new Error('moving the mouse right should turn Bravo from south to west: ' + await win.evaluate(() => document.querySelector('.pov-info')?.textContent))
  await win.keyboard.press('KeyT')
  await win.keyboard.type('!menu')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.pov-menu:not([hidden]) .mslot[data-slot="13"]', { timeout: 10000 })
  await win.hover('.pov-menu .mslot[data-slot="13"]')
  await win.screenshot({ path: path.join(shots, '05c-pov-menu.png') })
  await win.click('.pov-menu .mslot[data-slot="13"]')
  await waitUntil(() => bravo.windowClicks.some(c => c.slot === 13), 5000, 'the menu click to reach the server')
  await win.keyboard.press('Escape')
  await win.waitForSelector('.pov-menu', { state: 'hidden' })
  console.log('POV: looked around, opened a server menu from POV chat and clicked "Confirm"')

  // Macros: a template, then a macro built in the editor, run by its button and by a hotkey
  await win.click('#tab-macros')
  await win.click('#macro-templates')
  await win.click('.template:has-text("Sell everything") button')
  await win.waitForSelector('.macro-item:has-text("Sell all")')
  await sleep(500)
  const rows = await win.locator('.macro-item:has-text("Sell all")').count()
  if (rows !== 1) throw new Error(`a macro added from a template shows up ${rows} times in the list`)
  await win.click('#macro-new')
  await sleep(500)
  if (await win.locator('.macro-item:has-text("New macro")').count() !== 1) throw new Error('a new macro shows up more than once in the list')
  await win.fill('.macro-name', 'E2E macro')
  await win.click('#macro-add-step')
  await win.click('.step-menu button:has-text("Say")')
  await win.fill('.mstep.kind-chat input', '/macro-test {account}')
  await win.selectOption('.macro-trigger select.w-key', 'F8')
  await sleep(800) // saved shortly after typing
  await win.screenshot({ path: path.join(shots, '05d-macros.png') })
  await win.click('#macro-run')
  await waitUntil(() => ['Alpha', 'Bravo'].every(n => srv.received.some(r => r.message === `/macro-test ${n}` && r.username === n)), 8000, 'the macro to run on the online accounts')
  const before = srv.received.filter(r => r.message === '/macro-test Bravo').length
  await sleep(500)
  await win.keyboard.press('F8')
  await waitUntil(() => srv.received.filter(r => r.message === '/macro-test Bravo').length > before, 8000, 'the F8 hotkey to run it again')
  console.log('Macros: template added, macro built in the editor ran from Run and from F8')
  await win.click('#tab-chat')

  // per-account view filter
  await win.selectOption('#view-filter', { label: 'Bravo' })
  await sleep(300)
  await win.screenshot({ path: path.join(shots, '06-view-bravo.png') })
  await win.selectOption('#view-filter', 'all')

  // settings + privacy
  await win.click('#settings-btn')
  await win.waitForSelector('.settings')
  await win.screenshot({ path: path.join(shots, '07-settings.png') })
  await win.keyboard.press('Escape')
  await win.click('#privacy-btn')
  await win.waitForSelector('.privacy')
  await win.screenshot({ path: path.join(shots, '08-privacy.png') })
  await win.keyboard.press('Escape')

  // add-account dialog (the real Microsoft request is blocked in this test environment)
  await win.click('#add-account')
  await win.waitForSelector('.signin')
  await win.screenshot({ path: path.join(shots, '09-add-account.png') })
  await win.keyboard.press('Escape')

  // security checks inside the window
  const sec = await win.evaluate(() => ({
    hasRequire: typeof window.require,
    hasProcess: typeof window.process,
    bridgeKeys: Object.keys(window.minedeck || {}),
    location: location.href
  }))
  console.log('window security:', JSON.stringify(sec))
  if (sec.hasRequire !== 'undefined' || sec.hasProcess !== 'undefined') throw new Error('Node.js is exposed to the window')
  if (JSON.stringify(sec.bridgeKeys) !== JSON.stringify(['call', 'onEvent'])) throw new Error('unexpected bridge functions: ' + sec.bridgeKeys)
  if (!sec.location.startsWith('minedeck://app/')) throw new Error('window is not on the app origin')
  const blocked = await win.evaluate(async () => {
    try { await window.minedeck.call('notARealMethod'); return 'not blocked' } catch (e) { return 'blocked: ' + e.message }
  })
  console.log('unknown method:', blocked)
  if (!blocked.startsWith('blocked')) throw new Error('unknown bridge call was not rejected')
  const ext = await win.evaluate(() => window.minedeck.call('openExternal', 'https://evil.example.com/'))
  console.log('openExternal to random site allowed?', ext)
  if (ext !== false) throw new Error('openExternal accepted a site outside the allow list')
  const fetchBlocked = await win.evaluate(async () => {
    try { await fetch('https://example.com'); return 'fetch allowed' } catch (e) { return 'fetch blocked' }
  })
  console.log('renderer network:', fetchBlocked)
  if (fetchBlocked !== 'fetch blocked') throw new Error('the window can reach the network')

  // PC restarts without MineDeck closing normally (like a Windows Update restart):
  // with "Reconnect accounts on startup" on, the accounts come back by themselves
  await win.evaluate(() => window.minedeck.call('updateSettings', { resumeOnStart: true }))
  await sleep(500)
  app.process().kill('SIGKILL')
  await sleep(500)
  const second = await launch()
  await second.win.waitForSelector('.account')
  await second.win.waitForFunction(() => document.querySelector('#acc-count')?.textContent.startsWith('3 of 3'), null, { timeout: 60000 })
  console.log('after a forced restart: all 3 accounts reconnected by themselves')
  const kept = await second.win.evaluate(() => window.minedeck.call('getMacros'))
  if (kept.macros.map(m => m.name).sort().join() !== 'E2E macro,Sell all') throw new Error('macros were not kept: ' + kept.macros.map(m => m.name))
  console.log('macros kept after the restart:', kept.macros.map(m => m.name).join(', '))

  // disconnect all: nothing is reconnected next time
  await second.win.check('#select-all')
  await second.win.click('#disconnect-sel')
  await second.win.waitForFunction(() => document.querySelector('#acc-count')?.textContent.startsWith('0 of 3'), null, { timeout: 10000 })
  await waitUntil(() => (readConfig().resumeAccounts || []).length === 0, 10000, 'disconnected accounts to be forgotten')

  // the only console errors expected are the Content-Security-Policy blocks caused by the fetch check above
  const unexpected = errors.filter(e => !/example\.com/.test(e))
  console.log('console errors/warnings:', errors.length ? errors : 'none')
  if (unexpected.length) throw new Error('unexpected console errors: ' + unexpected.join(' | '))
  await second.app.close()
  await srv.close()
  const files = fs.readdirSync(dataDir)
  console.log('data dir files:', files.join(', '))
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  console.log('saved server:', JSON.stringify(cfg.servers))
  console.log('E2E OK')
}

main().catch((e) => { console.error('E2E FAILED:', e); process.exit(1) })
