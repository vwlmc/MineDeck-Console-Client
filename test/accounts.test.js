'use strict'
// Sign-ins are remembered across restarts: the account store saves tokens
// encrypted, and a new MineDeck session (a "restart") uses them without
// asking the user to sign in again.
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { mockBackend } = require('./helpers/mock-microsoft')
const { Endpoints } = require('../src/main/auth/microsoft')

// Stand-in for Electron's safeStorage (DPAPI on Windows): real AES-256-GCM
// with a key that belongs to "this Windows user".
function fakeSecureStore (key) {
  return {
    isAvailable: () => true,
    backend: () => 'dpapi',
    encryptJson (value) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')
    },
    decryptJson (blob) {
      try {
        const buf = Buffer.from(blob, 'base64')
        const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
        d.setAuthTag(buf.subarray(12, 28))
        return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString())
      } catch {
        return null
      }
    }
  }
}

// load src/main/accounts.js with the given secure store in place of Electron's
function loadAccountStore (secure) {
  const securePath = require.resolve('../src/main/secure-store')
  const accountsPath = require.resolve('../src/main/accounts')
  delete require.cache[accountsPath]
  const m = new Module(securePath)
  m.filename = securePath
  m.loaded = true
  m.exports = secure
  require.cache[securePath] = m
  return require('../src/main/accounts').AccountStore
}

const flush = () => new Promise(resolve => setTimeout(resolve, 400))

test('a signed-in account stays signed in after restarting MineDeck', async () => {
  const { fetchMock, calls } = mockBackend()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minedeck-accounts-'))
  const myKey = crypto.randomBytes(32)
  try {
    // first run: sign in once
    let AccountStore = loadAccountStore(fakeSecureStore(myKey))
    const first = new AccountStore(dir)
    first.load()
    const added = await first.signIn('sig_000000000001', () => {})
    assert.strictEqual(added.name, 'Steve')
    await flush()
    first.flush()

    // what's on disk: the name and UUID, and tokens nobody can read without this user's key
    const onDisk = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')
    // (each of these contains a quote or space, or is long enough, that it can't appear by chance in base64)
    for (const secret of ['"refreshToken"', '"accessToken"', 'MCTOKEN', 'PRIVATE KEY', '"msa"']) assert.ok(!onDisk.includes(secret), `${secret} must not be readable on disk`)
    const saved = JSON.parse(onDisk).accounts[0]
    assert.strictEqual(saved.name, 'Steve')
    assert.strictEqual(typeof saved.tokens, 'string')

    // "restart": a new MineDeck session reads the file
    const signInRequestsBefore = calls.filter(c => c.url === Endpoints.deviceCode).length
    const second = new AccountStore(dir)
    second.load()
    assert.strictEqual(second.publicList()[0].needsSignIn, false, 'no sign-in needed after a restart')
    const session = await second.getSession(added.id)
    assert.strictEqual(session.accessToken, 'MCTOKEN')
    assert.strictEqual(session.profile.name, 'Steve')

    // a day later: the Minecraft token has expired and is renewed with the saved refresh token
    second.get(added.id).ms.state.mc.expiresAt = Date.now() - 1000
    second.get(added.id).ms.state.msa.expiresAt = Date.now() - 1000
    second.get(added.id).ms.state.xbl.xsts.NotAfter = new Date(Date.now() - 1000).toISOString()
    second._persist()
    await flush()
    second.flush()
    const third = new AccountStore(dir)
    third.load()
    const renewed = await third.getSession(added.id)
    assert.strictEqual(renewed.accessToken, 'MCTOKEN')
    assert.ok(calls.some(c => c.url.startsWith(Endpoints.token) && new URLSearchParams(c.body).get('grant_type') === 'refresh_token'))
    assert.strictEqual(calls.filter(c => c.url === Endpoints.deviceCode).length, signInRequestsBefore, 'the user was never asked to sign in again')
    await flush()
    third.flush()

    // copied to another PC / Windows user: can't be unlocked, but isn't destroyed either
    AccountStore = loadAccountStore(fakeSecureStore(crypto.randomBytes(32)))
    const elsewhere = new AccountStore(dir)
    elsewhere.load()
    assert.strictEqual(elsewhere.publicList()[0].needsSignIn, true)
    elsewhere.move(added.id, 0) // any change saves the file
    elsewhere.flush()
    AccountStore = loadAccountStore(fakeSecureStore(myKey))
    const back = new AccountStore(dir)
    back.load()
    assert.strictEqual(back.publicList()[0].needsSignIn, false, 'the original user can still unlock it')
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
