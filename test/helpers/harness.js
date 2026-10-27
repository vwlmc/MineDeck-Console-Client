'use strict'
// Shared helpers for the integration tests: offline test accounts and a Manager
// wired to them, plus a polling wait.
const { Manager } = require('../../src/main/manager')
const { DEFAULT_SETTINGS } = require('../../src/main/settings')

function fakeAccounts (names) {
  const accounts = names.map((name, i) => ({ id: `acc_${i}`, name, uuid: `0000000000000000000000000000000${i}` }))
  return {
    accounts,
    get: (id) => accounts.find(a => a.id === id) || null,
    getSession: async (id) => {
      const a = accounts.find(x => x.id === id)
      return { accessToken: 'offline-test', profile: { id: a.uuid, name: a.name }, profileKeys: null }
    }
  }
}

function waitFor (fn, ms = 15000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let v
      try { v = fn() } catch { v = false }
      if (v) return resolve(v)
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

function makeManager (names, server, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, loginDelaySec: 0.5, loginJitterSec: 0, reconnectDelaySec: 1, reconnectMaxDelaySec: 2, sendDelayMs: 50, joinCommandDelaySec: 0.2, ...overrides }
  const accounts = fakeAccounts(names)
  const manager = new Manager({ accounts, getSettings: () => settings, getServer: () => server })
  const lines = []
  manager.on('line', l => lines.push(l))
  return { manager, accounts, settings, lines }
}

module.exports = { fakeAccounts, waitFor, makeManager }
