'use strict'
// Keeps the list of Microsoft accounts. Tokens live only in this process
// (main process) and in accounts.json encrypted by the OS; the window/UI only
// ever receives names, UUIDs and status flags.
const crypto = require('crypto')
const path = require('path')
const { EventEmitter } = require('events')
const { JsonFile } = require('./store')
const secure = require('./secure-store')
const { MicrosoftAccount, AuthError } = require('./auth/microsoft')

const MAX_ACCOUNTS = 200

class AccountStore extends EventEmitter {
  constructor (dir) {
    super()
    this.file = new JsonFile(path.join(dir, 'accounts.json'), { version: 1, accounts: [] })
    this.accounts = [] // { id, uuid, name, addedAt, needsSignIn, ms: MicrosoftAccount | null, lastError }
    this.signIns = new Map() // flowId -> AbortController
  }

  load () {
    const data = this.file.load()
    const list = Array.isArray(data.accounts) ? data.accounts : []
    this.accounts = list.slice(0, MAX_ACCOUNTS).filter(a => a && typeof a.id === 'string' && /^acc_[0-9a-f]{12}$/.test(a.id)).map(a => {
      const state = secure.decryptJson(a.tokens)
      const acc = {
        id: a.id,
        uuid: typeof a.uuid === 'string' ? a.uuid : '',
        name: typeof a.name === 'string' ? a.name : 'Unknown',
        addedAt: Number(a.addedAt) || Date.now(),
        needsSignIn: !state,
        ms: null,
        // tokens we couldn't unlock right now (for example a Linux keyring that
        // isn't unlocked yet) are kept as-is, still encrypted, instead of being lost
        sealed: !state && typeof a.tokens === 'string' ? a.tokens : null,
        lastError: null
      }
      if (state) {
        try {
          acc.ms = new MicrosoftAccount(state, () => this._persist())
        } catch {
          acc.needsSignIn = true
        }
      }
      return acc
    })
  }

  _persist () {
    this.file.data = {
      version: 1,
      accounts: this.accounts.map(a => ({
        id: a.id,
        uuid: a.uuid,
        name: a.name,
        addedAt: a.addedAt,
        // null when the OS has no secure storage: tokens then stay in memory only
        tokens: a.ms ? secure.encryptJson(a.ms.state) : (a.sealed || null)
      }))
    }
    this.file.save()
  }

  flush () {
    this.file.flush()
  }

  /** What the UI is allowed to see. */
  publicList () {
    return this.accounts.map(a => ({
      id: a.id,
      uuid: a.uuid,
      name: a.name,
      addedAt: a.addedAt,
      needsSignIn: a.needsSignIn || !a.ms,
      lastError: a.lastError
    }))
  }

  get (id) {
    return this.accounts.find(a => a.id === id) || null
  }

  /**
   * Device-code sign-in. Adds a new account, or refreshes the tokens of an
   * existing one when the same Minecraft profile signs in again.
   * onCode({ flowId, userCode, verificationUri, expiresAt }) shows the code.
   */
  async signIn (flowId, onCode) {
    if (this.accounts.length >= MAX_ACCOUNTS) throw new AuthError(`You can add up to ${MAX_ACCOUNTS} accounts.`)
    const controller = new AbortController()
    this.signIns.set(flowId, controller)
    try {
      const ms = new MicrosoftAccount({}, () => {})
      await ms.signInWithDeviceCode(code => onCode({ flowId, ...code }), controller.signal)
      const session = await ms.getSession({ withCertificates: false })
      let acc = this.accounts.find(a => a.uuid === session.profile.id)
      if (acc) {
        acc.ms = ms
        acc.sealed = null
        acc.name = session.profile.name
        acc.needsSignIn = false
        acc.lastError = null
      } else {
        acc = {
          id: 'acc_' + crypto.randomBytes(6).toString('hex'),
          uuid: session.profile.id,
          name: session.profile.name,
          addedAt: Date.now(),
          needsSignIn: false,
          ms,
          sealed: null,
          lastError: null
        }
        this.accounts.push(acc)
      }
      ms.save = () => this._persist()
      this._persist()
      this.emit('changed')
      return { id: acc.id, name: acc.name, uuid: acc.uuid }
    } finally {
      this.signIns.delete(flowId)
    }
  }

  cancelSignIn (flowId) {
    const c = this.signIns.get(flowId)
    if (c) c.abort()
  }

  remove (id) {
    const i = this.accounts.findIndex(a => a.id === id)
    if (i === -1) return false
    const [acc] = this.accounts.splice(i, 1)
    if (acc.ms) acc.ms.state = {} // drop tokens from memory
    acc.ms = null
    acc.sealed = null
    this._persist()
    this.emit('changed')
    return true
  }

  move (id, toIndex) {
    const i = this.accounts.findIndex(a => a.id === id)
    if (i === -1) return
    const [acc] = this.accounts.splice(i, 1)
    this.accounts.splice(Math.max(0, Math.min(this.accounts.length, toIndex)), 0, acc)
    this._persist()
    this.emit('changed')
  }

  /** Token + profile needed to join a server. Refreshes tokens when needed. */
  async getSession (id) {
    const acc = this.get(id)
    if (!acc) throw new AuthError('Account not found')
    if (!acc.ms) {
      acc.needsSignIn = true
      throw new AuthError('This account needs to sign in again.', { needsSignIn: true })
    }
    try {
      const session = await acc.ms.getSession({ withCertificates: true })
      if (session.profile.name !== acc.name) {
        acc.name = session.profile.name // the player changed their username
        this._persist()
      }
      if (acc.lastError || acc.needsSignIn) {
        acc.lastError = null
        acc.needsSignIn = false
        this.emit('changed')
      }
      return session
    } catch (e) {
      acc.lastError = e.message
      if (e.needsSignIn) {
        // Microsoft no longer accepts the saved sign-in: forget it
        acc.needsSignIn = true
        acc.ms = null
        acc.sealed = null
        this._persist()
      }
      this.emit('changed')
      throw e
    }
  }

  skinUrl (id) {
    return this.get(id)?.ms?.state?.skinUrl || null
  }

  /** Forget every account and token. */
  wipe () {
    for (const c of this.signIns.values()) c.abort()
    for (const a of this.accounts) if (a.ms) a.ms.state = {}
    this.accounts = []
    this._persist()
    this.file.flush()
    this.emit('changed')
  }
}

module.exports = { AccountStore }
