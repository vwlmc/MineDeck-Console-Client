'use strict'
// A simulated Microsoft / Xbox Live / Minecraft services backend for tests.
// Install it with globalThis.fetch = mockBackend().fetchMock.
const assert = require('node:assert')
const crypto = require('crypto')
const { Endpoints } = require('../../src/main/auth/microsoft')

function jsonResponse (status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function iso (msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString()
}

// Verifies an Xbox "Signature" header the way Xbox Live does
function verifyXboxSignature (url, body, header, publicJwk) {
  const raw = Buffer.from(header, 'base64')
  assert.strictEqual(raw.readInt32BE(0), 1, 'policy version')
  const ts = raw.readBigUInt64BE(4)
  const sig = raw.subarray(12)
  const path = new URL(url).pathname
  const parts = [Buffer.alloc(13)]
  parts[0].writeInt32BE(1, 0)
  parts[0].writeUInt8(0, 4)
  parts[0].writeBigUInt64BE(ts, 5)
  parts.push(Buffer.from([0]))
  for (const s of ['POST', path, '', body]) parts.push(Buffer.from(s), Buffer.from([0]))
  const key = crypto.createPublicKey({ key: publicJwk, format: 'jwk' })
  return crypto.verify('SHA256', Buffer.concat(parts), { key, dsaEncoding: 'ieee-p1363' }, sig)
}

function mockBackend ({ ownsGame = true } = {}) {
  const calls = []
  let polls = 0
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
  const fetchMock = async (url, opts = {}) => {
    const u = String(url)
    const body = opts.body ? String(opts.body) : ''
    calls.push({ url: u, body, headers: opts.headers || {} })
    if (u === Endpoints.deviceCode) {
      return jsonResponse(200, { device_code: 'DEV', user_code: 'ABCD1234', verification_uri: 'https://www.microsoft.com/link', expires_in: 900, interval: 1 })
    }
    if (u.startsWith(Endpoints.token)) {
      const p = new URLSearchParams(body)
      if (p.get('grant_type') === 'refresh_token') return jsonResponse(200, { access_token: 'MSA2', refresh_token: 'R2', expires_in: 3600 })
      polls++
      if (polls < 2) return jsonResponse(400, { error: 'authorization_pending' })
      return jsonResponse(200, { access_token: 'MSA1', refresh_token: 'R1', expires_in: 3600 })
    }
    if (u === Endpoints.xblUser) return jsonResponse(200, { Token: 'UT', NotAfter: iso(86400000) })
    if (u === Endpoints.xblDevice) return jsonResponse(200, { Token: 'DT', NotAfter: iso(86400000) })
    if (u === Endpoints.xblTitle) return jsonResponse(200, { Token: 'TT', NotAfter: iso(86400000) })
    if (u === Endpoints.xsts) return jsonResponse(200, { Token: 'XSTS', NotAfter: iso(16 * 3600000), DisplayClaims: { xui: [{ uhs: 'UHS' }] } })
    if (u === Endpoints.mcLogin) return jsonResponse(200, { access_token: 'MCTOKEN', expires_in: 86400 })
    if (u === Endpoints.mcProfile) {
      if (!ownsGame) return jsonResponse(404, { error: 'NOT_FOUND' })
      return jsonResponse(200, { id: '0123456789abcdef0123456789abcdef', name: 'Steve', skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/abc' }] })
    }
    if (u === Endpoints.mcCertificates) {
      return jsonResponse(200, {
        keyPair: { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) },
        publicKeySignature: Buffer.from('sig1').toString('base64'),
        publicKeySignatureV2: Buffer.from('sig2').toString('base64'),
        expiresAt: iso(48 * 3600000),
        refreshedAfter: iso(40 * 3600000)
      })
    }
    return jsonResponse(404, {})
  }
  return { fetchMock, calls }
}

module.exports = { mockBackend, verifyXboxSignature, jsonResponse, iso }
