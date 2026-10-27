'use strict'
// TEST-ONLY harness, loaded by test/e2e/app/entry.js when running the
// end-to-end UI test against local offline-mode test servers. It is not part
// of the app and is not shipped: it replaces Microsoft sign-in with fixed
// offline test accounts so the UI can be exercised without real accounts.
const path = require('path')
const { AccountStore } = require(path.join(__dirname, '..', '..', 'src', 'main', 'accounts.js'))

const names = (process.env.MINEDECK_TEST_ACCOUNTS || '').split(',').filter(Boolean)
const load = AccountStore.prototype.load
AccountStore.prototype.load = function () {
  load.call(this)
  if (this.accounts.length) return
  names.forEach((name, i) => {
    const hex = (i + 1).toString(16).padStart(12, '0')
    this.accounts.push({ id: `acc_${hex}`, uuid: `00000000000000000000${hex}`, name, addedAt: Date.now(), needsSignIn: false, ms: { state: {} }, lastError: null })
  })
}
AccountStore.prototype.getSession = async function (id) {
  const a = this.get(id)
  return { accessToken: 'offline-test', profile: { id: a.uuid, name: a.name }, profileKeys: null }
}
