'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { parseAddress, cleanServer, applySettingsPatch, DEFAULT_SETTINGS } = require('../src/main/settings')
const { toSegments, parseLegacy, plainText } = require('../src/main/chat-format')
const { listVersions, findVersion, versionForProtocol } = require('../src/main/versions')

test('server addresses', () => {
  assert.deepStrictEqual(parseAddress('play.example.com'), { host: 'play.example.com', port: 25565 })
  assert.deepStrictEqual(parseAddress(' mc.example.net:25570 '), { host: 'mc.example.net', port: 25570 })
  assert.deepStrictEqual(parseAddress('127.0.0.1:1'), { host: '127.0.0.1', port: 1 })
  assert.deepStrictEqual(parseAddress('[::1]:25566'), { host: '::1', port: 25566 })
  assert.strictEqual(parseAddress('bad host:25565'), null)
  assert.strictEqual(parseAddress('host:70000'), null)
  assert.strictEqual(parseAddress('http://evil/../x'), null)
  assert.strictEqual(parseAddress(''), null)
  assert.strictEqual(parseAddress({}), null)
})

test('server profiles are cleaned', () => {
  const s = cleanServer({ address: 'Play.Example.com:25566', name: '  ', version: '1.20.4', joinCommands: '/afk\n\n  /warp afk  \n' + 'x'.repeat(400) })
  assert.strictEqual(s.host, 'Play.Example.com')
  assert.strictEqual(s.port, 25566)
  assert.strictEqual(s.name, 'Play.Example.com')
  assert.strictEqual(s.version, '1.20.4')
  assert.deepStrictEqual(s.joinCommands.slice(0, 2), ['/afk', '/warp afk'])
  assert.strictEqual(s.joinCommands[2].length, 256)
  assert.strictEqual(cleanServer({ address: 'a.b', version: '9.9.9' }).version, 'auto')
  assert.throws(() => cleanServer({ address: 'not valid!' }))
})

test('settings patches are validated and clamped', () => {
  const s = applySettingsPatch(DEFAULT_SETTINGS, {
    loginDelaySec: 99999, antiAfk: 'fly', autoReconnect: 'yes', highlightWords: ['a', 5, ' b '], unknownKey: 1, reconnectDelaySec: 50, reconnectMaxDelaySec: 10
  })
  assert.strictEqual(s.loginDelaySec, 600)
  assert.strictEqual(s.antiAfk, 'off')
  assert.strictEqual(s.autoReconnect, true)
  assert.deepStrictEqual(s.highlightWords, ['a', 'b'])
  assert.ok(!('unknownKey' in s))
  assert.strictEqual(s.reconnectMaxDelaySec, 50, 'max delay is never below the first delay')
  assert.strictEqual(DEFAULT_SETTINGS.launchAtLogin, false, 'starting with Windows is opt-in')
  assert.strictEqual(applySettingsPatch(DEFAULT_SETTINGS, { launchAtLogin: true }).launchAtLogin, true)
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "toString": 2}')
  assert.doesNotThrow(() => applySettingsPatch(DEFAULT_SETTINGS, evil))
  assert.strictEqual({}.polluted, undefined)
})

test('chat components render like vanilla', () => {
  const lang = require('minecraft-data')('1.20.4').language
  const segs = toSegments({ text: '', extra: [{ text: 'A', color: 'red', bold: true }, { text: 'B' }, { translate: 'chat.type.text', with: ['Bob', 'hi'] }] }, lang)
  assert.deepStrictEqual(segs, [{ t: 'A', c: 'red', b: 1 }, { t: 'B<Bob> hi' }])
  assert.strictEqual(plainText(toSegments({ translate: 'unknown.key.%s', fallback: 'Fallback %s', with: ['x'] })), 'Fallback x')
  assert.deepStrictEqual(parseLegacy('§x§1§2§3§4§5§6hex§rplain'), [{ t: 'hex', c: '#123456' }, { t: 'plain' }])
  // nothing is ever interpreted as HTML: text stays text
  assert.strictEqual(plainText(parseLegacy('<img src=x onerror=alert(1)>')), '<img src=x onerror=alert(1)>')
  // deeply nested or huge input is bounded
  let deep = { text: 'x' }
  for (let i = 0; i < 1000; i++) deep = { text: '', extra: [deep] }
  assert.doesNotThrow(() => toSegments(deep))
  assert.ok(plainText(parseLegacy('a'.repeat(100000))).length <= 4000)
  // a translation that references its argument many times, nested: must stay fast
  let bomb = { text: '' } // empty text, so the length limit alone wouldn't stop it
  for (let i = 0; i < 24; i++) bomb = { translate: '%1$s%1$s%1$s%1$s', with: [bomb] }
  const t0 = Date.now()
  toSegments(bomb)
  assert.ok(Date.now() - t0 < 500, 'crafted message took too long')
})

test('clickable chat text and hover text are kept (and bounded)', () => {
  // "[ACCEPT]" buttons: JSON (up to 1.21.4) and the 1.21.5+ field names
  const seg = toSegments({
    text: 'Bob wants to teleport. ',
    extra: [
      { text: '[ACCEPT]', color: 'green', clickEvent: { action: 'run_command', value: '/tpaccept Bob' }, hoverEvent: { action: 'show_text', contents: { text: 'Click to accept' } } },
      { text: ' ' },
      { text: '[DENY]', click_event: { action: 'run_command', command: '/tpdeny' }, hover_event: { action: 'show_text', value: 'Deny' } },
      { text: ' §aVisit', clickEvent: { action: 'open_url', value: 'https://example.com' } }
    ]
  })
  const accept = seg.find(s => s.t === '[ACCEPT]')
  assert.deepStrictEqual(accept.k, { a: 'run_command', v: '/tpaccept Bob' })
  assert.strictEqual(accept.h, 'Click to accept')
  assert.deepStrictEqual(seg.find(s => s.t === '[DENY]').k, { a: 'run_command', v: '/tpdeny' })
  assert.strictEqual(seg.find(s => s.t === '[DENY]').h, 'Deny')
  // legacy colour codes inside clickable text keep the click
  assert.deepStrictEqual(seg.find(s => s.t === 'Visit').k, { a: 'open_url', v: 'https://example.com' })
  // unknown actions are dropped, and a message full of nested hovers can't explode the work
  assert.strictEqual(toSegments({ text: 'x', clickEvent: { action: 'change_page', value: 2 } })[0].k, undefined)
  let deep = { text: 'end' }
  for (let i = 0; i < 20; i++) deep = { text: `L${i}`, hoverEvent: { action: 'show_text', contents: [deep, deep, deep] }, extra: [deep, deep] }
  const t0 = Date.now()
  const out = toSegments(deep)
  assert.ok(Date.now() - t0 < 1000, 'bounded')
  assert.ok(out.length > 0)
})

test('version list covers 1.7.10 to 26.1.2', () => {
  const ids = listVersions().map(v => v.id)
  assert.strictEqual(ids[0], '26.1.2')
  assert.strictEqual(ids[ids.length - 1], '1.7.10')
  for (const v of ['26.1.1', '1.21.11', '1.20.4', '1.16.5', '1.12.2', '1.8.9', '1.8.8']) assert.ok(ids.includes(v), v)
  assert.strictEqual(findVersion('1.7.10').engine, 'legacy')
  assert.strictEqual(findVersion('1.8.9').dataVersion, '1.8.8')
  assert.strictEqual(versionForProtocol(775).id, '26.1.2')
  assert.strictEqual(versionForProtocol(47).id, '1.8.9')
  assert.strictEqual(versionForProtocol(99999), null)
})

test('join commands are encrypted in config.json when secure storage exists', () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { JsonFile } = require('../src/main/store')
  const { createJoinCommandsVault } = require('../src/main/join-commands-vault')
  const fakeSecure = (available) => ({
    isAvailable: () => available,
    encryptJson: (v) => available ? 'ENC:' + Buffer.from(JSON.stringify(v)).toString('base64') : null,
    decryptJson: (b) => available && b.startsWith('ENC:') ? JSON.parse(Buffer.from(b.slice(4), 'base64').toString()) : null
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minedeck-vault-'))
  const file = path.join(dir, 'config.json')
  const server = { id: 'srv_000000000001', name: 'x', host: 'h', port: 25565, version: 'auto', joinCommands: ['/login hunter2', '/afk'] }

  // with secure storage: nothing readable on disk, round-trips intact
  let cfg = new JsonFile(file, { servers: [] }, createJoinCommandsVault(fakeSecure(true)))
  cfg.load(); cfg.data.servers = [server]; cfg.saveNow()
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(!raw.includes('hunter2') && raw.includes('joinCommandsSealed'))
  cfg = new JsonFile(file, { servers: [] }, createJoinCommandsVault(fakeSecure(true)))
  assert.deepStrictEqual(cfg.load().servers[0].joinCommands, ['/login hunter2', '/afk'])

  // keyring locked this time: commands look empty but the encrypted copy survives a save
  const locked = createJoinCommandsVault(fakeSecure(false))
  cfg = new JsonFile(file, { servers: [] }, locked)
  assert.deepStrictEqual(cfg.load().servers[0].joinCommands, [])
  cfg.saveNow()
  cfg = new JsonFile(file, { servers: [] }, createJoinCommandsVault(fakeSecure(true)))
  assert.deepStrictEqual(cfg.load().servers[0].joinCommands, ['/login hunter2', '/afk'])

  // encryption failing never falls back to plain text
  const broken = { isAvailable: () => true, encryptJson: () => null, decryptJson: () => null }
  cfg = new JsonFile(file, { servers: [] }, createJoinCommandsVault(broken))
  cfg.data = { servers: [server] }; cfg.saveNow()
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hunter2'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('passwords in login commands are masked', () => {
  const { maskSecrets, isSecretCommand } = require('../src/main/secrets')
  assert.strictEqual(maskSecrets('/login hunter2'), '/login ••••••')
  assert.strictEqual(maskSecrets('/register pw pw'), '/register ••••••')
  assert.strictEqual(maskSecrets('/warp spawn'), '/warp spawn')
  assert.strictEqual(maskSecrets('/lobby'), '/lobby')
  assert.ok(isSecretCommand('/changepassword old new'))
  assert.ok(!isSecretCommand('hello /login x'))
})
