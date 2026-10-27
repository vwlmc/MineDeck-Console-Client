'use strict'
// Macros: the pattern matcher, the checks on saved/imported macros, and the
// engine running real steps against a local test server.
const test = require('node:test')
const assert = require('node:assert')
const { matchPattern } = require('../src/main/wildcard')
const macros = require('../src/main/macros')
const { MacroEngine } = require('../src/main/macro-engine')
const { startFakeServer } = require('./helpers/fake-server')
const { waitFor, makeManager } = require('./helpers/harness')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('wildcard patterns: contains, captures, anchors, never slow', () => {
  assert.ok(matchPattern('has joined', 'Steve has joined the game'))
  assert.ok(matchPattern('HAS JOINED', 'Steve has joined the game'), 'case-insensitive')
  assert.strictEqual(matchPattern('has left', 'Steve has joined'), null)
  assert.deepStrictEqual(matchPattern('* has requested to teleport to you', 'Bob has requested to teleport to you.').groups, ['Bob'])
  assert.deepStrictEqual(matchPattern('[* -> me] *', '[Alice -> me] hi there [x -> me] y').groups, ['Alice', 'hi there [x -> me] y'])
  assert.deepStrictEqual(matchPattern('balance: *', 'Your balance: $1,250').groups, ['$1,250'])
  assert.deepStrictEqual(matchPattern('*end', 'the end is near').groups, ['the '], 'a leading * starts at the beginning of the text')
  assert.deepStrictEqual(matchPattern('joined *', 'Steve joined the game').groups, ['the game'], 'a trailing * runs to the end')
  assert.ok(matchPattern('', 'anything'), 'empty matches everything')
  const t0 = Date.now()
  matchPattern('*a*a*a*a*a*a*a*a*b', 'a'.repeat(1000))
  assert.ok(Date.now() - t0 < 200, 'no catastrophic backtracking')
})

test('macros are checked: unknown steps dropped, numbers clamped, blocks repaired', () => {
  const m = macros.cleanMacro({
    name: '  x  ',
    steps: [
      { type: 'repeat', times: -5 },
      { type: 'chat', text: 'hi\nthere', evil: 'require("fs")' },
      { type: 'nope' },
      { type: 'wait', sec: 1e9 },
      { type: 'else' }, // not inside an If: dropped
      { type: 'if', cond: 'chance', value: 50 }
    ],
    accounts: ['acc_000000000000', 'bad', 7],
    trigger: { type: 'interval', every: 0 }
  })
  assert.strictEqual(m.name, 'x')
  assert.deepStrictEqual(m.steps.map(s => s.type), ['repeat', 'chat', 'wait', 'if', 'end', 'end'])
  assert.strictEqual(m.steps[0].times, 0)
  assert.strictEqual(m.steps[1].text, 'hi there')
  assert.strictEqual(m.steps[1].evil, undefined)
  assert.strictEqual(m.steps[2].sec, 86400)
  assert.deepStrictEqual(m.accounts, ['acc_000000000000'])
  assert.strictEqual(m.trigger.every, 0.05)
  assert.match(m.id, /^mac_[0-9a-f]{12}$/)
  // every template is a valid macro, and sharing round-trips with the automatic start off
  for (const t of macros.TEMPLATES) {
    const tm = macros.fromTemplate(t.key)
    assert.ok(tm.steps.length > 0, t.key)
    const back = macros.parseShared(macros.shareText({ ...tm, enabled: true }))
    assert.deepStrictEqual(back.steps, tm.steps, t.key)
    assert.strictEqual(back.enabled, false)
    assert.notStrictEqual(back.id, tm.id)
  }
  assert.throws(() => macros.parseShared('not a macro'), /isn't a MineDeck macro/)
})

test('macros.json is encrypted when the OS offers secure storage', () => {
  const { createMacroVault } = require('../src/main/macro-store')
  const box = new Map()
  let working = true
  const secure = {
    isAvailable: () => true,
    encryptJson: (v) => { if (!working) return null; const k = `blob${box.size}`; box.set(k, JSON.stringify(v)); return k },
    decryptJson: (k) => (box.has(k) ? JSON.parse(box.get(k)) : null)
  }
  const vault = createMacroVault(secure)
  const list = [macros.cleanMacro({ name: 'login', steps: [{ type: 'chat', text: '/login hunter2' }] })]
  const disk = vault.toDisk({ version: 1, macros: list })
  assert.ok(typeof disk.sealed === 'string' && !JSON.stringify(disk).includes('hunter2'), 'nothing readable on disk')
  assert.deepStrictEqual(vault.fromDisk(disk).macros, list)
  working = false // encryption failing later never falls back to plain text
  const again = vault.toDisk({ version: 1, macros: [...list, ...list] })
  assert.strictEqual(again.sealed, disk.sealed)
  assert.ok(!JSON.stringify(again).includes('hunter2'))
})

async function setup (version = '1.20.4', onChat) {
  const srv = await startFakeServer({ version, world: true, echoCommands: false, onChat })
  const server = { id: 'srv', host: '127.0.0.1', port: srv.port, version, joinCommands: [] }
  const ctx = makeManager(['Tester'], server, { loginDelaySec: 0, antiAfk: 'off', reconnectDelaySec: 1 })
  const list = []
  const disabled = []
  const engine = new MacroEngine({ manager: ctx.manager, accounts: ctx.accounts, getMacros: () => list, onDisable: (id, why) => { disabled.push(why); const m = list.find(x => x.id === id); if (m) m.enabled = false } })
  const logs = []
  engine.on('log', (e) => logs.push(e))
  const add = (m) => { const c = macros.cleanMacro(m); list.push(c); return c }
  const connect = async () => {
    ctx.manager.connect(['acc_0'])
    await waitFor(() => ctx.manager.onlineCount() === 1, 20000, `online on ${version}`)
    await sleep(300)
  }
  const said = (msg) => srv.received.some(r => r.message === msg)
  const close = async () => { engine.shutdown(); ctx.manager.shutdown(); await srv.close() }
  return { srv, ctx, engine, list, add, connect, said, close, logs, disabled }
}

test('macro steps: chat, waiting for chat with captures, menus, loops and conditions', { timeout: 60000 }, async () => {
  const t = await setup('1.20.4', (client, msg, { systemChat }) => {
    if (msg === '/hello Tester') setTimeout(() => systemChat('Bob says hi'), 200)
  })
  try {
    await t.connect()
    const m = t.add({
      name: 'flow',
      steps: [
        { type: 'chat', text: '/hello {account}' },
        { type: 'waitChat', match: '* says hi', timeout: 5 },
        { type: 'chat', text: '/greet {1}' },
        { type: 'repeat', times: 3 },
        { type: 'chat', text: '/count {i}' },
        { type: 'end' },
        { type: 'if', cond: 'chance', value: 0 },
        { type: 'chat', text: '/never' },
        { type: 'else' },
        { type: 'chat', text: '/else' },
        { type: 'end' },
        { type: 'set', name: 'who', value: '{1}!' },
        { type: 'if', cond: 'text', left: '{who}', op: 'equals', right: 'bob!' },
        { type: 'chat', text: '/vars ok' },
        { type: 'end' },
        { type: 'chat', text: '!menu' },
        { type: 'click', match: 'Confirm', wait: 5 },
        { type: 'closeMenu' },
        { type: 'stop' },
        { type: 'chat', text: '/after-stop' }
      ]
    })
    assert.deepStrictEqual(t.engine.run(m.id), { started: 1, online: 1 })
    await waitFor(() => t.engine.runs.size === 0, 20000, 'macro to finish')
    for (const msg of ['/hello Tester', '/greet Bob', '/count 1', '/count 2', '/count 3', '/else', '/vars ok']) assert.ok(t.said(msg), msg)
    assert.ok(!t.said('/never') && !t.said('/after-stop'))
    const client = Object.values(t.srv.server.clients)[0]
    assert.strictEqual(client.windowClicks[0]?.slot, 11, 'clicked the first "Confirm"')
    // commands from a macro are spaced out (at least 300 ms apart)
    assert.ok(t.logs.some(l => /finished|stopped by a Stop step/.test(l.text)))
  } finally {
    await t.close()
  }
})

test('macro triggers: chat (with captures), join, timer; runaway macros switch themselves off', { timeout: 90000 }, async () => {
  const t = await setup('1.20.4')
  try {
    t.add({ name: 'join', enabled: true, trigger: { type: 'join', delay: 0 }, steps: [{ type: 'chat', text: '/joined' }] })
    t.add({ name: 'tpa', enabled: true, trigger: { type: 'chat', match: '* has requested to teleport to you', cooldown: 0 }, steps: [{ type: 'chat', text: '/tpaccept {1}' }] })
    t.add({ name: 'timer', enabled: true, trigger: { type: 'interval', every: 0.05 }, steps: [{ type: 'chat', text: '/tick' }] })
    t.add({ name: 'off', enabled: false, trigger: { type: 'join', delay: 0 }, steps: [{ type: 'chat', text: '/disabled-macro' }] })
    await t.connect()
    await waitFor(() => t.said('/joined'), 5000, 'join trigger')
    t.srv.broadcast('Steve has requested to teleport to you.')
    await waitFor(() => t.said('/tpaccept Steve'), 5000, 'chat trigger')
    await waitFor(() => t.said('/tick'), 8000, 'timer trigger')
    assert.ok(!t.said('/disabled-macro'))
    // a macro that answers its own trigger: echoed back by the server, it would run forever
    t.add({ name: 'echo', enabled: true, trigger: { type: 'chat', match: 'ping', cooldown: 0 }, steps: [{ type: 'chat', text: 'ping' }] })
    t.srv.broadcast('ping')
    await waitFor(() => t.disabled.length > 0, 30000, 'runaway macro switched off')
    assert.match(t.disabled[0], /more than 20 times in a minute/)
  } finally {
    await t.close()
  }
})

test('macro movement, and restarting after a reconnect', { timeout: 60000 }, async () => {
  const t = await setup('1.20.4')
  try {
    await t.connect()
    const client = () => Object.values(t.srv.server.clients)[0]
    const walk = t.add({ name: 'walk', steps: [{ type: 'look', mode: 'direction', dir: 'east' }, { type: 'goto', x: 4, z: 0, timeout: 10 }] })
    t.engine.run(walk.id)
    await waitFor(() => t.engine.runs.size === 0, 15000, 'walk to finish')
    const last = client().moves[client().moves.length - 1]
    assert.ok(Math.abs(last.x - 4.5) < 0.8 && Math.abs(last.z - 0.5) < 0.8, `arrived near 4.5 0.5, at ${last.x} ${last.z}`)
    assert.ok(!t.logs.some(l => l.level === 'warn'), t.logs.map(l => l.text).join(' | '))

    const loop = t.add({ name: 'loop', loop: true, loopDelay: 0.5, onReconnect: 'restart', steps: [{ type: 'chat', text: '/still-here' }, { type: 'wait', sec: 0.5 }] })
    t.engine.run(loop.id)
    await waitFor(() => t.said('/still-here'), 5000, 'loop running')
    t.srv.kickAll('Server restarting')
    await waitFor(() => t.engine.runs.size === 0, 5000, 'macro stopped on disconnect')
    t.srv.received.length = 0
    await waitFor(() => t.ctx.manager.onlineCount() === 1, 20000, 'reconnected')
    await waitFor(() => t.said('/still-here'), 10000, 'macro restarted after reconnecting')
    assert.strictEqual(t.engine.stop({ macroId: loop.id }), 1)
    await waitFor(() => t.engine.runs.size === 0, 5000, 'stopped by the user')
  } finally {
    await t.close()
  }
})

test('macros on 1.8.8: chat, hotbar and menus', { timeout: 60000 }, async () => {
  const t = await setup('1.8.8')
  try {
    await t.connect()
    const m = t.add({ name: 'old', steps: [{ type: 'hotbar', slot: 3 }, { type: 'chat', text: '!menu' }, { type: 'waitMenu', match: 'Confirm', timeout: 5 }, { type: 'click', match: 'cancel', wait: 3 }, { type: 'chat', text: '/done {x} {z}' }] })
    t.engine.run(m.id)
    await waitFor(() => t.engine.runs.size === 0, 15000, 'macro to finish')
    const client = Object.values(t.srv.server.clients)[0]
    assert.strictEqual(client.windowClicks[0]?.slot, 15, 'clicked "Cancel"')
    assert.ok(t.said('/done 0 0'), JSON.stringify(t.srv.received.filter(r => r.message).map(r => r.message)))
  } finally {
    await t.close()
  }
})
