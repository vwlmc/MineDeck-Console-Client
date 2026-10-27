'use strict'
// macros.json: the saved macros. Macros can hold passwords ("/login ..."), so
// the whole list is encrypted with the OS (DPAPI on Windows) like sign-ins are.
// Without secure storage (some Linux setups) it is saved as plain text and the
// Macros tab says so.
const path = require('path')
const { JsonFile } = require('./store')
const { cleanMacro, MAX_MACROS } = require('./macros')

function createMacroVault (secure) {
  let lastSealed = null // the last successful encryption, reused if encrypting ever fails
  let leftover = null // a list we couldn't unlock (keyring locked): kept until something replaces it
  return {
    toDisk (data) {
      const macros = Array.isArray(data.macros) ? data.macros : []
      if (!secure.isAvailable()) return { version: 1, macros }
      if (!macros.length && leftover) return { version: 1, sealed: leftover }
      const sealed = secure.encryptJson(macros)
      if (sealed) { lastSealed = sealed; leftover = null; return { version: 1, sealed } }
      // never fall back to plain text when encryption is expected
      return { version: 1, sealed: lastSealed || leftover || secure.encryptJson([]) || '' }
    },
    fromDisk (data) {
      if (typeof data.sealed === 'string' && data.sealed) {
        const macros = secure.decryptJson(data.sealed)
        if (Array.isArray(macros)) { lastSealed = data.sealed; return { version: 1, macros } }
        leftover = data.sealed
        return { version: 1, macros: [] }
      }
      return { version: 1, macros: Array.isArray(data.macros) ? data.macros : [] }
    }
  }
}

function openMacroStore (dir, secure) {
  const store = new JsonFile(path.join(dir, 'macros.json'), { version: 1, macros: [] }, createMacroVault(secure))
  store.load()
  store.data.macros = store.data.macros.flatMap(m => {
    try { return [cleanMacro(m)] } catch { return [] }
  }).slice(0, MAX_MACROS)
  return store
}

module.exports = { openMacroStore, createMacroVault }
