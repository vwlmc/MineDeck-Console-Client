'use strict'
// Real servers do things a quiet test server doesn't: offer resource packs,
// kill you, send packets MineDeck can't parse. Each of these used to be able
// to break a connection silently (chat stopped arriving, then a timeout).
const test = require('node:test')
const assert = require('node:assert')
const { startFakeServer } = require('./helpers/fake-server')
const { waitFor, makeManager } = require('./helpers/harness')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function online (version, overrides = {}, serverOptions = {}) {
  const srv = await startFakeServer({ version, ...serverOptions })
  const server = { id: 'srv', host: '127.0.0.1', port: srv.port, version, joinCommands: [] }
  const ctx = makeManager(['Tester'], server, { loginDelaySec: 0, ...overrides })
  ctx.manager.connect(['acc_0'])
  await waitFor(() => ctx.manager.onlineCount() === 1, 20000, `online on ${version}`)
  const client = Object.values(srv.server.clients)[0]
  return { srv, client, ...ctx }
}

async function chatStillWorks (ctx, text) {
  ctx.manager.sendChat(text, ['acc_0'])
  await waitFor(() => ctx.srv.received.some(r => r.message === text), 5000, `"${text}" at the server`)
}

async function close (ctx) {
  ctx.manager.shutdown()
  await ctx.srv.close()
}

test('resource packs are answered correctly on every protocol generation', async () => {
  const cases = [
    ['1.8.8', true, { hash: '0123456789abcdef0123456789abcdef01234567' }], // hash in the answer
    ['1.8.8', false, { hash: '0123456789abcdef0123456789abcdef01234567' }],
    ['1.12.2', true, {}], // result only
    ['1.20.4', false, { uuid: '7a3b2f8e-1c4d-4e5f-9a6b-0c1d2e3f4a5b' }], // pack UUID
    ['26.1', true, { uuid: '7a3b2f8e-1c4d-4e5f-9a6b-0c1d2e3f4a5b' }]
  ]
  for (const [version, accept, fields] of cases) {
    const ctx = await online(version, { acceptResourcePacks: accept }, { resourcePack: true })
    try {
      await waitFor(() => ctx.client.resourcePackAnswers.length >= (accept ? 2 : 1), 5000, `pack answer on ${version}`)
      const expected = (accept ? [3, 0] : [1]).map(result => ({ ...fields, result }))
      assert.deepStrictEqual(ctx.client.resourcePackAnswers, expected, `${version} ${accept ? 'accept' : 'decline'}`)
      await chatStillWorks(ctx, `chat after pack ${version}`)
    } finally {
      await close(ctx)
    }
  }
})

test('dying and respawning keeps the connection (1.7.10, 1.8.8, 1.12.2, 26.1)', async () => {
  for (const version of ['1.7.10', '1.8.8', '1.12.2', '26.1']) {
    const ctx = await online(version)
    try {
      const respawns = []
      ctx.client.on('client_command', p => respawns.push(p))
      await sleep(300)
      ctx.client.write('update_health', { health: 0, food: 20, foodSaturation: 5 })
      await waitFor(() => respawns.length > 0, 5000, `respawn on ${version}`)
      const action = respawns[0].payload ?? respawns[0].actionId
      assert.strictEqual(action, 'perform_respawn', version)
      await chatStillWorks(ctx, `alive again ${version}`)
    } finally {
      await close(ctx)
    }
  }
})

test('every anti-AFK action can be sent (1.7.10, 1.8.8, 1.20.4, 26.1)', async () => {
  for (const version of ['1.7.10', '1.8.8', '1.20.4', '26.1']) {
    const ctx = await online(version)
    try {
      const session = ctx.manager.slots.get('acc_0').session
      for (const mode of ['swing', 'look', 'jump', 'sneak']) session._antiAfkTick(mode)
      await sleep(1200)
      assert.strictEqual(ctx.manager.slots.get('acc_0').session, session, `${version}: connection survived`)
      await chatStillWorks(ctx, `afk done ${version}`)
    } finally {
      await close(ctx)
    }
  }
})

test('a packet MineDeck fails to handle is skipped instead of freezing the connection', async () => {
  const ctx = await online('1.8.8')
  try {
    ctx.manager.slots.get('acc_0').session.client.on('experience', () => { throw new Error('simulated handler bug') })
    const realError = console.error
    console.error = () => {}
    try {
      ctx.client.write('experience', { experienceBar: 0.5, level: 3, totalExperience: 30 })
      await sleep(300)
    } finally {
      console.error = realError
    }
    ctx.srv.broadcast('still receiving')
    await waitFor(() => ctx.lines.some(l => l.kind === 'chat' && l.text === 'still receiving'), 5000, 'chat after the bad packet')
    assert.ok(ctx.lines.some(l => l.kind === 'event' && /Skipped a "experience" packet/.test(l.text)))
  } finally {
    await close(ctx)
  }
})

test('a connection that can no longer send is closed and reconnected right away', async () => {
  const ctx = await online('1.8.8', { reconnectDelaySec: 1 })
  try {
    const started = Date.now()
    // a packet that can't be encoded: from here on minecraft-protocol can't send anything
    ctx.manager.slots.get('acc_0').session.client.write('resource_pack_receive', { result: 3 })
    await waitFor(() => ctx.manager.publicSlots().acc_0.status !== 'online', 5000, 'the broken connection to be noticed')
    assert.ok(Date.now() - started < 4000, 'noticed within seconds, not after a server timeout')
    await waitFor(() => ctx.manager.onlineCount() === 1, 15000, 'reconnected')
    await chatStillWorks(ctx, 'back again')
  } finally {
    await close(ctx)
  }
})
