'use strict'
/*
 * Microsoft account sign-in for Minecraft: Java Edition.
 *
 * How it works (nothing here ever sees your password):
 *   1. We ask login.live.com for a short "device code".
 *   2. You open https://www.microsoft.com/link in YOUR browser, type the code and
 *      sign in on Microsoft's own page.
 *   3. Microsoft gives this app tokens, which are exchanged with Xbox Live and
 *      Minecraft's servers for a Minecraft session token.
 *
 * Tokens are only ever sent to Microsoft / Xbox Live / Mojang (Minecraft)
 * servers. They are kept in memory and, when the operating system provides
 * secure storage, saved encrypted on this computer (see ../secure-store.js).
 *
 * Adapted from prismarine-auth (MIT License, Copyright (c) PrismarineJS),
 * keeping only the "live" device-code flow that minecraft-protocol uses by
 * default. See THIRD_PARTY_NOTICES.md.
 */
const crypto = require('crypto')

// Microsoft OAuth client used by minecraft-protocol / mineflayer by default
// (the "Minecraft for Nintendo Switch" title).
const CLIENT_ID = '00000000441cc96b'
const DEVICE_TYPE = 'Nintendo'
const DEVICE_VERSION = '0.0.0'
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'

const Endpoints = {
  deviceCode: 'https://login.live.com/oauth20_connect.srf',
  token: 'https://login.live.com/oauth20_token.srf',
  xblUser: 'https://user.auth.xboxlive.com/user/authenticate',
  xblDevice: 'https://device.auth.xboxlive.com/device/authenticate',
  xblTitle: 'https://title.auth.xboxlive.com/title/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  mcProfile: 'https://api.minecraftservices.com/minecraft/profile',
  mcCertificates: 'https://api.minecraftservices.com/player/certificates'
}
const MC_RELYING_PARTY = 'rp://api.minecraftservices.com/'
const MC_HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'MinecraftLauncher/2.2.10675' }
const XBL_HEADERS = { 'Cache-Control': 'no-store, must-revalidate, no-cache', 'x-xbl-contract-version': '1' }
const REQUEST_TIMEOUT_MS = 20000

const XBOX_ERRORS = {
  2148916227: 'This account was banned by Xbox and cannot be used.',
  2148916229: 'This account is restricted. A parent or guardian must allow online play at account.microsoft.com/family.',
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at minecraft.net or xbox.com to create one.',
  2148916234: "This account hasn't accepted the Xbox Terms of Service. Sign in at xbox.com and accept them.",
  2148916235: 'Xbox Live is not available in this account\'s region.',
  2148916236: 'This account needs proof of age. Sign in at login.live.com to complete it.',
  2148916237: 'This account has reached its playtime limit.',
  2148916238: 'This account is under 18 and must be added to a family by an adult.'
}

class AuthError extends Error {
  constructor (message, { code, needsSignIn = false, cause } = {}) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.needsSignIn = needsSignIn
    if (cause) this.cause = cause
  }
}

async function request (url, options = {}) {
  let res
  try {
    res = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw new AuthError(`Timed out contacting ${new URL(url).host}`, { code: 'timeout', cause: e })
    throw new AuthError(`Could not reach ${new URL(url).host}. Check your internet connection.`, { code: 'network', cause: e })
  }
  const text = await res.text()
  let data = text
  if (text && ((res.headers.get('content-type') || '').includes('json') || /^\s*[{[]/.test(text))) {
    try { data = JSON.parse(text) } catch { /* keep text */ }
  }
  return { res, data }
}

function isValid (expiresAtMs, marginMs = 60000) {
  return typeof expiresAtMs === 'number' && expiresAtMs - Date.now() > marginMs
}

function pemToDer (pem) {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
}

/**
 * One Microsoft account. `state` is a plain JSON object holding every token;
 * `save(state)` is called whenever it changes so the caller can persist it
 * (encrypted). Nothing in `state` is ever sent to the UI.
 */
class MicrosoftAccount {
  constructor (state = {}, save = () => {}) {
    this.state = state
    this.save = save
    this.pending = null
    if (!this.state.proofKey) {
      // Xbox Live "proof of possession" key. Kept with the tokens so cached
      // device/title tokens stay valid across restarts.
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
      this.state.proofKey = privateKey.export({ format: 'pem', type: 'pkcs8' })
    }
    this.privateKey = crypto.createPrivateKey(this.state.proofKey)
    this.jwk = { ...crypto.createPublicKey(this.privateKey).export({ format: 'jwk' }), alg: 'ES256', use: 'sig' }
  }

  _persist () {
    try { this.save(this.state) } catch { /* saving is best-effort */ }
  }

  // ---------------- Microsoft (login.live.com) ----------------

  /**
   * Starts device-code sign-in. `onCode({ userCode, verificationUri, expiresAt })`
   * is called once the code is ready. Resolves when the user has signed in.
   * Pass an AbortSignal to cancel.
   */
  async signInWithDeviceCode (onCode, signal) {
    const body = new URLSearchParams({ scope: SCOPE, client_id: CLIENT_ID, response_type: 'device_code' })
    const { res, data } = await request(Endpoints.deviceCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!res.ok || !data.device_code) throw new AuthError('Microsoft did not return a sign-in code. Try again in a minute.', { code: 'device_code' })
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
    const expiresAt = Date.now() + data.expires_in * 1000
    onCode({
      userCode: data.user_code,
      verificationUri: data.verification_uri || 'https://www.microsoft.com/link',
      expiresAt
    })

    let interval = Math.max(1, Number(data.interval) || 5) * 1000
    while (Date.now() < expiresAt - 1000) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, interval)
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new AuthError('Sign-in cancelled', { code: 'cancelled' })) }, { once: true })
      })
      if (signal?.aborted) throw new AuthError('Sign-in cancelled', { code: 'cancelled' })
      const poll = await request(`${Endpoints.token}?client_id=${CLIENT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams({ client_id: CLIENT_ID, device_code: data.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString()
      }).catch(() => null) // network blips while waiting are fine; keep polling
      if (!poll) continue
      const tok = poll.data
      if (tok && tok.access_token) {
        this._setMsaTokens(tok)
        // a new Microsoft login invalidates any older Xbox/Minecraft tokens
        delete this.state.xbl
        delete this.state.mc
        delete this.state.certs
        this._persist()
        return true
      }
      if (tok && tok.error === 'slow_down') interval += 5000 // RFC 8628: poll less often
      else if (tok && tok.error && tok.error !== 'authorization_pending') {
        if (tok.error === 'expired_token') break
        if (tok.error === 'authorization_declined' || tok.error === 'access_denied') throw new AuthError('Sign-in was declined on the Microsoft page.', { code: tok.error })
        throw new AuthError(`Microsoft sign-in failed (${tok.error}).`, { code: tok.error })
      }
    }
    throw new AuthError('The sign-in code expired. Start again.', { code: 'expired' })
  }

  _setMsaTokens (tok) {
    this.state.msa = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || this.state.msa?.refreshToken,
      expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000
    }
  }

  async _getMsaAccessToken (forceRefresh = false) {
    const msa = this.state.msa
    if (!msa || !msa.refreshToken) throw new AuthError('This account needs to sign in again.', { code: 'no_msa', needsSignIn: true })
    if (!forceRefresh && isValid(msa.expiresAt)) return msa.accessToken
    const { res, data } = await request(Endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ scope: SCOPE, client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: msa.refreshToken }).toString()
    })
    if (!res.ok || !data.access_token) {
      const expired = data && (data.error === 'invalid_grant' || data.error === 'unauthorized_client')
      throw new AuthError(expired ? 'This account\'s sign-in has expired. Sign in again.' : 'Could not refresh the Microsoft sign-in.',
        { code: data?.error || 'refresh_failed', needsSignIn: expired })
    }
    this._setMsaTokens(data)
    this._persist()
    return data.access_token
  }

  // ---------------- Xbox Live ----------------

  // Signature required by Xbox Live for requests that use a proof key.
  _sign (url, payload) {
    const windowsTimestamp = (BigInt(Math.floor(Date.now() / 1000)) + 11644473600n) * 10000000n
    const path = new URL(url).pathname
    const parts = []
    const head = Buffer.alloc(13)
    head.writeInt32BE(1, 0) // policy version
    head.writeUInt8(0, 4)
    head.writeBigUInt64BE(windowsTimestamp, 5)
    parts.push(head, Buffer.from([0]))
    for (const s of ['POST', path, '', payload]) parts.push(Buffer.from(s, 'utf8'), Buffer.from([0]))
    const signature = crypto.sign('SHA256', Buffer.concat(parts), { key: this.privateKey, dsaEncoding: 'ieee-p1363' })
    const header = Buffer.alloc(12)
    header.writeInt32BE(1, 0)
    header.writeBigUInt64BE(windowsTimestamp, 4)
    return Buffer.concat([header, signature]).toString('base64')
  }

  async _xblPost (url, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload)
    const { res, data } = await request(url, {
      method: 'POST',
      headers: { ...XBL_HEADERS, ...extraHeaders, Signature: this._sign(url, body), 'Content-Type': 'application/json', Accept: 'application/json' },
      body
    })
    if (!res.ok) {
      const xerr = Number(res.headers.get('x-err') || (data && data.XErr))
      if (XBOX_ERRORS[xerr]) throw new AuthError(XBOX_ERRORS[xerr], { code: `xerr_${xerr}`, needsSignIn: false })
      throw new AuthError(`Xbox Live sign-in failed (HTTP ${res.status}${xerr ? `, XErr ${xerr}` : ''}).`, { code: `xbl_${res.status}` })
    }
    return data
  }

  _cachedXbl (name) {
    const t = this.state.xbl?.[name]
    return t && isValid(Date.parse(t.NotAfter)) ? t.Token : null
  }

  async _getXsts (forceRefresh = false) {
    const cached = this.state.xbl?.xsts
    if (!forceRefresh && cached && isValid(Date.parse(cached.NotAfter), 5 * 60000)) return cached
    if (forceRefresh) delete this.state.xbl
    this.state.xbl = this.state.xbl || {}

    const msaToken = await this._getMsaAccessToken(forceRefresh)

    let userToken = this._cachedXbl('userToken')
    if (!userToken) {
      const r = await this._xblPost(Endpoints.xblUser, {
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `t=${msaToken}` }
      }, { 'x-xbl-contract-version': '2' })
      this.state.xbl.userToken = { Token: r.Token, NotAfter: r.NotAfter }
      userToken = r.Token
    }

    let deviceToken = this._cachedXbl('deviceToken')
    if (!deviceToken) {
      const r = await this._xblPost(Endpoints.xblDevice, {
        Properties: {
          AuthMethod: 'ProofOfPossession',
          Id: `{${crypto.randomUUID()}}`,
          DeviceType: DEVICE_TYPE,
          SerialNumber: `{${crypto.randomUUID()}}`,
          Version: DEVICE_VERSION,
          ProofKey: this.jwk
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT'
      })
      this.state.xbl.deviceToken = { Token: r.Token, NotAfter: r.NotAfter }
      deviceToken = r.Token
    }

    let titleToken = this._cachedXbl('titleToken')
    if (!titleToken) {
      const r = await this._xblPost(Endpoints.xblTitle, {
        Properties: {
          AuthMethod: 'RPS',
          DeviceToken: deviceToken,
          RpsTicket: `t=${msaToken}`,
          SiteName: 'user.auth.xboxlive.com',
          ProofKey: this.jwk
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT'
      })
      this.state.xbl.titleToken = { Token: r.Token, NotAfter: r.NotAfter }
      titleToken = r.Token
    }

    const r = await this._xblPost(Endpoints.xsts, {
      RelyingParty: MC_RELYING_PARTY,
      TokenType: 'JWT',
      Properties: { UserTokens: [userToken], DeviceToken: deviceToken, TitleToken: titleToken, ProofKey: this.jwk, SandboxId: 'RETAIL' }
    })
    const xsts = { Token: r.Token, NotAfter: r.NotAfter, userHash: r.DisplayClaims?.xui?.[0]?.uhs }
    if (!xsts.userHash) throw new AuthError('Xbox Live returned an incomplete token.', { code: 'xsts_incomplete' })
    this.state.xbl.xsts = xsts
    this._persist()
    return xsts
  }

  // ---------------- Minecraft ----------------

  async _getMinecraftToken (forceRefresh = false) {
    const mc = this.state.mc
    if (!forceRefresh && mc && isValid(mc.expiresAt, 5 * 60000)) return mc.accessToken
    let xsts = await this._getXsts(false)
    let attempt = await this._loginWithXbox(xsts)
    if (!attempt.ok && attempt.status !== 429) {
      // the cached Xbox tokens may have been revoked; get fresh ones once
      xsts = await this._getXsts(true)
      attempt = await this._loginWithXbox(xsts)
    }
    if (!attempt.ok) {
      if (attempt.status === 429) throw new AuthError('Minecraft\'s login servers are rate limiting this network. Wait a few minutes and try again.', { code: 'mc_429' })
      throw new AuthError(`Minecraft login failed (HTTP ${attempt.status}).`, { code: `mc_${attempt.status}` })
    }
    this.state.mc = { accessToken: attempt.data.access_token, expiresAt: Date.now() + (Number(attempt.data.expires_in) || 86400) * 1000 }
    this._persist()
    return this.state.mc.accessToken
  }

  async _loginWithXbox (xsts) {
    const { res, data } = await request(Endpoints.mcLogin, {
      method: 'POST',
      headers: MC_HEADERS,
      body: JSON.stringify({ identityToken: `XBL3.0 x=${xsts.userHash};${xsts.Token}` })
    })
    return { ok: res.ok && data && data.access_token, status: res.status, data }
  }

  async _fetchProfile (accessToken) {
    const { res, data } = await request(Endpoints.mcProfile, { headers: { ...MC_HEADERS, Authorization: `Bearer ${accessToken}` } })
    if (res.status === 404) throw new AuthError("This Microsoft account doesn't own Minecraft: Java Edition (or hasn't created a username yet).", { code: 'no_profile' })
    if (res.status === 429) throw new AuthError('Minecraft\'s servers are rate limiting this network. Wait a few minutes and try again.', { code: 'profile_429' })
    if (!res.ok || !data?.id || !data?.name) throw new AuthError(`Could not load the Minecraft profile (HTTP ${res.status}).`, { code: `profile_${res.status}` })
    return { id: data.id, name: data.name, skins: Array.isArray(data.skins) ? data.skins : [] }
  }

  async _getCertificates (accessToken) {
    const c = this.state.certs
    if (c && isValid(Date.parse(c.refreshedAfter) || Date.parse(c.expiresAt), 5 * 60000)) return c
    const { res, data } = await request(Endpoints.mcCertificates, { method: 'POST', headers: { ...MC_HEADERS, Authorization: `Bearer ${accessToken}` } })
    if (!res.ok || !data?.keyPair) return null // chat signing is optional; many servers don't need it
    this.state.certs = {
      privateKey: data.keyPair.privateKey,
      publicKey: data.keyPair.publicKey,
      publicKeySignature: data.publicKeySignature,
      publicKeySignatureV2: data.publicKeySignatureV2,
      expiresAt: data.expiresAt,
      refreshedAfter: data.refreshedAfter
    }
    this._persist()
    return this.state.certs
  }

  /**
   * Returns everything needed to join a server:
   *   { accessToken, profile: { id, name }, profileKeys | null }
   * Refreshes expired tokens automatically.
   */
  async getSession ({ withCertificates = true } = {}) {
    if (this.pending) return this.pending
    this.pending = (async () => {
      let accessToken = await this._getMinecraftToken(false)
      let profile
      try {
        profile = await this._fetchProfile(accessToken)
      } catch (e) {
        if (e.code !== 'profile_401') throw e
        accessToken = await this._getMinecraftToken(true)
        profile = await this._fetchProfile(accessToken)
      }
      this.state.profile = { id: profile.id, name: profile.name }
      const skin = profile.skins.find(s => s.state === 'ACTIVE') || profile.skins[0]
      this.state.skinUrl = skin && typeof skin.url === 'string' ? skin.url : null
      this._persist()
      let profileKeys = null
      if (withCertificates) {
        const certs = await this._getCertificates(accessToken).catch(() => null)
        if (certs) profileKeys = toProfileKeys(certs)
      }
      return { accessToken, profile: this.state.profile, profileKeys }
    })()
    try {
      return await this.pending
    } finally {
      this.pending = null
    }
  }
}

// The structure minecraft-protocol expects in client.profileKeys
function toProfileKeys (certs) {
  const publicDER = pemToDer(certs.publicKey)
  const privateDER = pemToDer(certs.privateKey)
  return {
    publicPEM: certs.publicKey,
    privatePEM: certs.privateKey,
    publicDER,
    privateDER,
    signature: Buffer.from(certs.publicKeySignature || '', 'base64'),
    signatureV2: Buffer.from(certs.publicKeySignatureV2 || '', 'base64'),
    expiresOn: new Date(certs.expiresAt),
    refreshAfter: new Date(certs.refreshedAfter),
    public: crypto.createPublicKey({ key: publicDER, format: 'der', type: 'spki' }),
    private: crypto.createPrivateKey({ key: privateDER, format: 'der', type: 'pkcs8' })
  }
}

module.exports = { MicrosoftAccount, AuthError, Endpoints, CLIENT_ID, _internal: { toProfileKeys, pemToDer } }
