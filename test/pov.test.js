'use strict'
// POV: the world, the player's own state and server menus reach the window,
// and looking, walking and clicking menu items reach the server.
const test = require('node:test')
const assert = require('node:assert')
const { startFakeServer } = require('./helpers/fake-server')
const { waitFor, makeManager } = require('./helpers/harness')
const { PovHost } = require('../src/main/pov')
const { KIND } = require('../src/main/block-colors')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function watch (version) {
  const srv = await startFakeServer({ version, world: true })
  const server = { id: 'srv', host: '127.0.0.1', port: srv.port, version, joinCommands: [] }
  const ctx = makeManager(['Tester'], server, { loginDelaySec: 0, antiAfk: 'off' })
  const events = []
  const host = new PovHost(ctx.manager, (e) => events.push(e))
  ctx.manager.connect(['acc_0'])
  await waitFor(() => ctx.manager.onlineCount() === 1, 20000, `online on ${version}`)
  const client = Object.values(srv.server.clients)[0]
  return { srv, client, host, events, ...ctx }
}

const last = (events, kind) => [...events].reverse().find(e => e.kind === kind)

async function check (version) {
  const ctx = await watch(version)
  const { host, events, client, srv } = ctx
  try {
    const opened = host.open('acc_0')
    assert.strictEqual(opened.ok, true, `${version}: open`)

    // the world arrives: the grass/stone floor and the glass block, as palette entries + sections
    await waitFor(() => events.some(e => e.kind === 'init'), 5000, `${version}: init`)
    await waitFor(() => {
      const palette = events.filter(e => e.kind === 'sections').flatMap(e => e.data.palette)
      return palette.some(p => /grass/.test(p.name)) && palette.some(p => p.name === 'glass' && p.kind === KIND.GLASS)
    }, 8000, `${version}: world sections`)
    const sections = events.filter(e => e.kind === 'sections').flatMap(e => e.data.sections)
    const floor = sections.find(s => s.cx === 0 && s.cz === 0 && s.cy === 4 && s.data)
    assert.ok(floor, `${version}: the section holding y 64 is sent`)
    assert.ok(floor.data instanceof Uint16Array && floor.data.length === 4096)
    assert.ok(floor.data[(0 * 16 + 0) * 16 + 0] > 0, `${version}: y 64 is solid`) // y 64 is local y 0 of section 4
    assert.strictEqual(floor.data[(1 * 16 + 0) * 16 + 0], 0, `${version}: y 65 is air`)

    // own state
    await waitFor(() => last(events, 'self') && last(events, 'entities'), 3000, `${version}: self + entities`)
    const self = last(events, 'self').data
    assert.ok(Math.abs(self.x - 0.5) < 1 && Math.abs(self.z - 0.5) < 1, `${version}: position`)
    assert.strictEqual(self.health, 20)
    assert.ok(last(events, 'inventory').data.hotbar.length === 9)

    // look + walk: the server sees the player move
    assert.strictEqual(host.action('look', Math.PI / 2, 0), true) // west
    const before = client.moves.length
    assert.strictEqual(host.action('control', { forward: true, sprint: false, bogus: true }), true)
    await sleep(700)
    host.action('control', { forward: false })
    await waitFor(() => client.moves.length > before && client.moves[client.moves.length - 1].x < 0, 3000, `${version}: walked west`)

    // a server menu: shown, clickable, and closed by the server
    ctx.manager.sendChat('!menu', ['acc_0'])
    await waitFor(() => last(events, 'window')?.data?.slots?.[13], 5000, `${version}: menu shown`)
    const w = last(events, 'window').data
    assert.match(w.title.map(s => s.t).join(''), /Confirm purchase\?/)
    assert.strictEqual(w.columns, 9)
    assert.strictEqual(w.size, 27)
    assert.match(w.slots[13].name, /wool/)
    assert.strictEqual(w.slots[13].label.map(x => x.t).join(''), 'Confirm', `${version}: custom item name`)
    assert.strictEqual(w.slots[13].lore.map(l => l.map(x => x.t).join('')).join('|'), 'Click to confirm', `${version}: item lore`)
    assert.strictEqual(w.slots[15].label.map(x => x.t).join(''), 'Cancel')
    assert.ok(ctx.lines.some(l => /opened a menu \("Confirm purchase\?"\)/.test(l.text)), `${version}: menu notice in chat`)
    assert.strictEqual(host.action('click', 13, 0, false), true)
    await waitFor(() => client.windowClicks.length > 0, 5000, `${version}: window_click at the server`)
    assert.strictEqual(client.windowClicks[0].slot, 13)
    assert.strictEqual(client.windowClicks[0].mouseButton, 0)
    srv.received.length = 0
    ctx.manager.sendChat('!close', ['acc_0'])
    await waitFor(() => last(events, 'window') && last(events, 'window').data === null, 5000, `${version}: menu closed`)

    // bad input is refused, not passed on
    assert.strictEqual(host.action('click', 999, 0, false), false)
    assert.strictEqual(host.action('hotbar', 12), false)
    assert.strictEqual(host.action('look', 'x', 0), false)
    assert.strictEqual(host.action('nope'), false)

    // the connection is still healthy after all of that
    ctx.manager.sendChat('still here', ['acc_0'])
    await waitFor(() => srv.received.some(r => r.message === 'still here'), 5000, `${version}: chat after POV`)
    host.close()
    assert.strictEqual(host.controller, null)
    const count = events.length
    await sleep(300)
    assert.strictEqual(events.length, count, `${version}: nothing is sent after closing`)
  } finally {
    host.close()
    ctx.manager.shutdown()
    await srv.close()
  }
}

for (const version of ['1.8.8', '1.12.2', '1.16.5', '1.20.4', '1.21.4', '1.21.8', '26.1']) {
  test(`POV on ${version}: world, movement and menus`, { timeout: 60000 }, () => check(version))
}

test('POV re-attaches when the account reconnects', { timeout: 60000 }, async () => {
  const ctx = await watch('1.20.4')
  try {
    ctx.host.open('acc_0')
    await waitFor(() => ctx.events.some(e => e.kind === 'self'), 5000, 'first update')
    ctx.srv.kickAll('Server restarting')
    await waitFor(() => ctx.events.some(e => e.kind === 'end'), 5000, 'end after kick')
    const n = ctx.events.filter(e => e.kind === 'init').length
    await waitFor(() => ctx.events.filter(e => e.kind === 'init').length > n, 20000, 'init after reconnect')
    assert.strictEqual(ctx.host.id, 'acc_0')
  } finally {
    ctx.host.close()
    ctx.manager.shutdown()
    await ctx.srv.close()
  }
})

test('POV shows death and can respawn when auto-respawn is off', { timeout: 60000 }, async () => {
  for (const version of ['1.8.8', '1.20.4']) {
    const srv = await startFakeServer({ version, world: true })
    const server = { id: 'srv', host: '127.0.0.1', port: srv.port, version, joinCommands: [] }
    const ctx = makeManager(['Tester'], server, { loginDelaySec: 0, antiAfk: 'off', autoRespawn: false })
    const events = []
    const host = new PovHost(ctx.manager, (e) => events.push(e))
    try {
      ctx.manager.connect(['acc_0'])
      await waitFor(() => ctx.manager.onlineCount() === 1, 20000, `online on ${version}`)
      const client = Object.values(srv.server.clients)[0]
      const commands = []
      client.on('client_command', (p) => commands.push(p))
      host.open('acc_0')
      await waitFor(() => last(events, 'self'), 5000, `${version}: self`)
      client.write('update_health', { health: 0, food: 20, foodSaturation: 0 })
      await waitFor(() => last(events, 'self')?.data.alive === false, 5000, `${version}: dead`)
      assert.strictEqual(host.action('respawn'), true)
      await waitFor(() => commands.length > 0, 5000, `${version}: respawn request at the server`)
    } finally {
      host.close()
      ctx.manager.shutdown()
      await srv.close()
    }
  }
})
