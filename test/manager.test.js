'use strict'
// Integration tests: real connections to small local test servers.
// Run with: node --test test/
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const { startFakeServer } = require('./helpers/fake-server')
const { waitFor, makeManager } = require('./helpers/harness')

test('login queue, chat in both directions, and join commands (1.20.4)', async () => {
  const srv = await startFakeServer({ version: '1.20.4' })
  const server = { id: 's1', host: '127.0.0.1', port: srv.port, version: '1.20.4', joinCommands: ['/afk'] }
  const { manager, lines, accounts } = makeManager(['Alpha', 'Bravo', 'Charlie'], server)
  const startTimes = {}
  const getSession = accounts.getSession
  accounts.getSession = (id) => { startTimes[id] = Date.now(); return getSession(id) }
  try {
    manager.connect(['acc_0', 'acc_1', 'acc_2'])
    await waitFor(() => manager.onlineCount() === 3, 20000, 'all online')
    const times = Object.values(startTimes).sort((a, b) => a - b)
    assert.strictEqual(times.length, 3)
    assert.ok(times[1] - times[0] >= 450 && times[2] - times[1] >= 450, `logins should be spaced by the delay: ${times}`)

    await waitFor(() => srv.received.filter(r => r.message === '/afk').length === 3, 8000, 'join commands')

    srv.broadcast('§aServer says hi')
    await waitFor(() => lines.filter(l => l.kind === 'chat' && l.text === 'Server says hi').length === 3, 8000, 'broadcast seen by all')
    const colored = lines.find(l => l.text === 'Server says hi')
    assert.deepStrictEqual(colored.seg, [{ t: 'Server says hi', c: 'green' }])

    const res = manager.sendChat('hello world', ['acc_0', 'acc_2'])
    assert.deepStrictEqual(res, { sent: 2, skipped: 0 })
    await waitFor(() => srv.received.filter(r => r.message === 'hello world').length === 2, 8000, 'messages at server')
    assert.deepStrictEqual(srv.received.filter(r => r.message === 'hello world').map(r => r.username).sort(), ['Alpha', 'Charlie'])

    // a login password reaches the server but is never shown in (or logged from) the chat window
    manager.sendChat('/login hunter2', ['acc_1'])
    await waitFor(() => srv.received.some(r => r.message === '/login hunter2'), 8000, 'login command at server')
    const sent = lines.filter(l => l.kind === 'sent' && l.acc === 'acc_1').pop()
    assert.strictEqual(sent.text, '/login ••••••')
    // (the test server itself echoes commands as chat; MineDeck's own lines must not contain it)
    assert.ok(!lines.some(l => l.kind !== 'chat' && l.text.includes('hunter2')))
  } finally {
    manager.shutdown()
    await srv.close()
  }
})

test('kick -> auto reconnect; ban message -> stop (1.12.2)', async () => {
  const srv = await startFakeServer({ version: '1.12.2' })
  const server = { id: 's2', host: '127.0.0.1', port: srv.port, version: '1.12.2', joinCommands: [] }
  const { manager } = makeManager(['Delta'], server)
  try {
    manager.connect(['acc_0'])
    await waitFor(() => manager.onlineCount() === 1, 15000, 'online')
    srv.kickAll('Server restarting')
    await waitFor(() => manager.publicSlots().acc_0.status === 'waiting', 5000, 'waiting to reconnect')
    assert.match(manager.publicSlots().acc_0.message, /Server restarting/)
    await waitFor(() => manager.onlineCount() === 1, 15000, 'reconnected')

    srv.kickAll('You are banned from this server!')
    await waitFor(() => manager.publicSlots().acc_0.status === 'stopped', 5000, 'stopped after ban')
    await new Promise(r => setTimeout(r, 2500))
    assert.strictEqual(manager.publicSlots().acc_0.status, 'stopped', 'must not reconnect after a ban')
  } finally {
    manager.shutdown()
    await srv.close()
  }
})

test('version auto-detect picks the server version (1.16.5)', async () => {
  const srv = await startFakeServer({ version: '1.16.5' })
  const server = { id: 's3', host: '127.0.0.1', port: srv.port, version: 'auto', joinCommands: [] }
  const { manager } = makeManager(['Echo'], server)
  try {
    const ping = await manager.ping('127.0.0.1', srv.port)
    assert.strictEqual(ping.protocol, 754)
    assert.strictEqual(ping.matchedVersion, '1.16.5')
    manager.connect(['acc_0'])
    await waitFor(() => manager.onlineCount() === 1, 15000, 'online')
    assert.strictEqual(manager.publicSlots().acc_0.version, '1.16.5')
  } finally {
    manager.shutdown()
    await srv.close()
  }
})

test('1.7.10 legacy engine joins and chats', async () => {
  const srv = await startFakeServer({ version: '1.7.10' })
  const server = { id: 's4', host: '127.0.0.1', port: srv.port, version: '1.7.10', joinCommands: [] }
  const { manager, lines } = makeManager(['Foxtrot'], server)
  try {
    manager.connect(['acc_0'])
    await waitFor(() => manager.onlineCount() === 1, 15000, 'online')
    await waitFor(() => lines.some(l => l.kind === 'chat' && l.text === 'Welcome Foxtrot!'), 5000, 'welcome')
    manager.sendChat('old school', ['acc_0'])
    await waitFor(() => srv.received.some(r => r.message === 'old school'), 5000, 'chat at server')
  } finally {
    manager.shutdown()
    await srv.close()
  }
})

test('server down -> keeps retrying -> connects when it comes back; manual disconnect stops (26.1)', async () => {
  // find a free port, start with nothing listening there
  const port = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const server = { id: 's5', host: '127.0.0.1', port, version: '26.1.2', joinCommands: [] }
  const { manager } = makeManager(['Golf'], server)
  let srv
  try {
    manager.connect(['acc_0'])
    await waitFor(() => manager.publicSlots().acc_0.status === 'waiting', 8000, 'first failure')
    assert.match(manager.publicSlots().acc_0.message, /refused/i)
    srv = await startFakeServer({ version: '26.1', port })
    await waitFor(() => manager.onlineCount() === 1, 20000, 'online after server came back')
    assert.strictEqual(manager.publicSlots().acc_0.version, '26.1.2')
    manager.disconnect(['acc_0'])
    await waitFor(() => manager.publicSlots().acc_0.status === 'offline', 5000, 'offline')
    await new Promise(r => setTimeout(r, 2500))
    assert.strictEqual(manager.publicSlots().acc_0.status, 'offline', 'manual disconnect must not reconnect')
  } finally {
    manager.shutdown()
    if (srv) await srv.close()
  }
})

test('online-mode servers: the access token only goes to Mojang\'s session server, and encryption works (1.20.4, 1.7.10)', async () => {
  const realFetch = globalThis.fetch
  const hosts = []
  const joins = new Map() // serverId hash -> join request body
  const { manager, accounts } = makeManager(['Alpha', 'Bravo'], null)
  const byUuid = Object.fromEntries(accounts.accounts.map(a => [a.uuid, a]))
  accounts.getSession = async (id) => {
    const a = accounts.get(id)
    return { accessToken: `secret-token-${a.name}`, profile: { id: a.uuid, name: a.name }, profileKeys: null }
  }
  // stand-in for sessionserver.mojang.com, used by both the client (join) and the test server (hasJoined)
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url))
    hosts.push(u.host)
    if (u.host !== 'sessionserver.mojang.com') throw new Error(`unexpected request to ${u.host}`)
    if (u.pathname === '/session/minecraft/join') {
      const body = JSON.parse(opts.body)
      joins.set(body.serverId, body)
      return new Response(null, { status: 204 })
    }
    if (u.pathname === '/session/minecraft/hasJoined') {
      const j = joins.get(u.searchParams.get('serverId'))
      const acc = j && byUuid[j.selectedProfile]
      if (!acc || j.accessToken !== `secret-token-${acc.name}` || u.searchParams.get('username') !== acc.name) return new Response(null, { status: 204 })
      return Response.json({ id: acc.uuid, name: acc.name, properties: [] })
    }
    throw new Error(`unexpected path ${u.pathname}`)
  }
  const servers = []
  try {
    for (const version of ['1.20.4', '1.7.10']) {
      const srv = await startFakeServer({ version, online: true })
      servers.push(srv)
      const server = { id: `on-${version}`, host: '127.0.0.1', port: srv.port, version, joinCommands: [] }
      manager.getServer = () => server
      joins.clear()
      manager.connect(['acc_0', 'acc_1'])
      await waitFor(() => manager.onlineCount() === 2, 20000, `both online on ${version}`)
      assert.strictEqual(joins.size, 2, 'each account joined through the session server')
      for (const j of joins.values()) assert.match(j.accessToken, /^secret-token-/)
      // the server saw the real (verified) names
      manager.sendChat('hello', ['acc_0', 'acc_1'])
      await waitFor(() => srv.received.filter(r => r.message === 'hello').length === 2, 8000, 'chat over the encrypted connection')
      assert.deepStrictEqual(srv.received.map(r => r.username).sort(), ['Alpha', 'Bravo'])
      manager.disconnect(['acc_0', 'acc_1'])
      await waitFor(() => manager.onlineCount() === 0, 8000, 'disconnected')
    }
    assert.ok(hosts.length > 0)
    assert.deepStrictEqual([...new Set(hosts)], ['sessionserver.mojang.com'], 'no other host was contacted')
  } finally {
    globalThis.fetch = realFetch
    manager.shutdown()
    for (const s of servers) await s.close()
  }
})
