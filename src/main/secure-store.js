'use strict'
/*
 * Encrypts account tokens with the operating system's secure storage:
 *   Windows: DPAPI (tied to your Windows user account)
 *   macOS:   Keychain
 *   Linux:   the desktop keyring (libsecret / kwallet)
 *
 * Only someone signed in to this computer as you can decrypt them.
 * If the OS has no secure storage (for example Linux without a keyring), tokens
 * are kept in memory only and you sign in again after restarting the app:
 * MineDeck never writes tokens to disk unencrypted.
 */
const { safeStorage } = require('electron')

function backend () {
  try {
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend()
    }
  } catch { /* not available before app ready */ }
  return process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'unknown'
}

function isAvailable () {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
  } catch {
    return false
  }
  // "basic_text" on Linux means "obfuscated with a hard-coded key", which is not real protection
  return backend() !== 'basic_text'
}

function encryptJson (value) {
  if (!isAvailable()) return null
  try {
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  } catch (e) {
    console.error('[secure-store] encryption failed:', e.message)
    return null // callers then keep the data in memory only
  }
}

function decryptJson (blob) {
  if (!blob || !isAvailable()) return null
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64')))
  } catch {
    return null // a different Windows user / reinstalled OS can't decrypt: sign in again
  }
}

module.exports = { isAvailable, backend, encryptJson, decryptJson }
