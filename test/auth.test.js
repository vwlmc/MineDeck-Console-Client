'use strict'
// Tests the sign-in code against a simulated Microsoft / Xbox / Mojang backend.
const test = require('node:test')
const assert = require('node:assert')
const { MicrosoftAccount, Endpoints } = require('../src/main/auth/microsoft')

const { mockBackend, verifyXboxSignature, iso } = require('./helpers/mock-microsoft')

test('device-code sign-in, Xbox signatures, Minecraft session and caching', async () => {
  const { fetchMock, calls } = mockBackend()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const saved = []
    const acc = new MicrosoftAccount({}, (state) => saved.push(JSON.parse(JSON.stringify(state))))
    let shown
    await acc.signInWithDeviceCode((code) => { shown = code })
    assert.strictEqual(shown.userCode, 'ABCD1234')
    assert.strictEqual(shown.verificationUri, 'https://www.microsoft.com/link')

    const session = await acc.getSession()
    assert.strictEqual(session.accessToken, 'MCTOKEN')
    assert.deepStrictEqual(session.profile, { id: '0123456789abcdef0123456789abcdef', name: 'Steve' })
    assert.ok(session.profileKeys && session.profileKeys.public && session.profileKeys.private, 'chat signing keys')
    assert.strictEqual(session.profileKeys.signatureV2.toString(), 'sig2')

    // every Xbox request is signed with the account's proof key
    for (const ep of [Endpoints.xblUser, Endpoints.xblDevice, Endpoints.xblTitle, Endpoints.xsts]) {
      const c = calls.find(x => x.url === ep)
      assert.ok(c, `called ${ep}`)
      assert.ok(verifyXboxSignature(ep, c.body, c.headers.Signature, acc.jwk), `valid signature for ${ep}`)
    }
    const xsts = JSON.parse(calls.find(c => c.url === Endpoints.xsts).body)
    assert.strictEqual(xsts.RelyingParty, 'rp://api.minecraftservices.com/')
    assert.deepStrictEqual(xsts.Properties.UserTokens, ['UT'])
    assert.strictEqual(JSON.parse(calls.find(c => c.url === Endpoints.mcLogin).body).identityToken, 'XBL3.0 x=UHS;XSTS')

    // tokens only ever go to Microsoft / Xbox / Mojang hosts
    const hosts = new Set(calls.map(c => new URL(c.url).host))
    for (const h of hosts) assert.ok(/(^|\.)live\.com$|(^|\.)xboxlive\.com$|(^|\.)minecraftservices\.com$/.test(h), `unexpected host ${h}`)

    // state was saved and a second getSession uses the cache (no new Xbox / login calls)
    assert.ok(saved.length > 0 && saved[saved.length - 1].mc.accessToken === 'MCTOKEN')
    const before = calls.length
    const again = await acc.getSession()
    assert.strictEqual(again.accessToken, 'MCTOKEN')
    const newCalls = calls.slice(before).map(c => c.url)
    assert.deepStrictEqual(newCalls, [Endpoints.mcProfile], 'only the profile is re-fetched')

    // a restored account (from saved state) keeps the same proof key
    const restored = new MicrosoftAccount(saved[saved.length - 1], () => {})
    assert.deepStrictEqual(restored.jwk, acc.jwk)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('expired Minecraft token is refreshed through the Microsoft refresh token', async () => {
  const { fetchMock, calls } = mockBackend()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const acc = new MicrosoftAccount({}, () => {})
    await acc.signInWithDeviceCode(() => {})
    await acc.getSession()
    // expire everything except the refresh token
    acc.state.msa.expiresAt = Date.now() - 1000
    acc.state.mc.expiresAt = Date.now() - 1000
    acc.state.xbl.xsts.NotAfter = iso(-1000)
    const before = calls.length
    const s = await acc.getSession()
    assert.strictEqual(s.accessToken, 'MCTOKEN')
    const refreshed = calls.slice(before).find(c => c.url.startsWith(Endpoints.token))
    assert.ok(refreshed && new URLSearchParams(refreshed.body).get('grant_type') === 'refresh_token')
    assert.strictEqual(acc.state.msa.accessToken, 'MSA2')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('account without Minecraft gets a clear error', async () => {
  const { fetchMock } = mockBackend({ ownsGame: false })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const acc = new MicrosoftAccount({}, () => {})
    await acc.signInWithDeviceCode(() => {})
    await assert.rejects(acc.getSession(), /doesn't own Minecraft/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('sign-in can be cancelled', async () => {
  const { fetchMock } = mockBackend()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const acc = new MicrosoftAccount({}, () => {})
    const controller = new AbortController()
    const p = acc.signInWithDeviceCode(() => setTimeout(() => controller.abort(), 100), controller.signal)
    await assert.rejects(p, /cancelled/)
  } finally {
    globalThis.fetch = realFetch
  }
})
