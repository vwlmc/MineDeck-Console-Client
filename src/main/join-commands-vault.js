'use strict'
// Join commands can hold a server password ("/login ..."), so in config.json
// they are encrypted like account tokens whenever the OS offers secure storage.
// Without secure storage they are saved as typed (the server dialog says so).
//
// createJoinCommandsVault(secure) returns hooks for JsonFile:
//   toDisk(data)   -> copy of data with each server's joinCommands encrypted
//   fromDisk(data) -> data with joinCommands decrypted
//   forget(id)     -> drop encrypted commands kept for a server we couldn't unlock
function createJoinCommandsVault (secure) {
  // encrypted commands we couldn't unlock this time (for example a Linux keyring
  // that isn't unlocked yet) are written back unchanged instead of being lost
  const leftovers = new Map()

  function toDisk (data) {
    if (!data || !Array.isArray(data.servers)) return data
    return {
      ...data,
      servers: data.servers.map(s => {
        const { joinCommands, ...rest } = s
        if (Array.isArray(joinCommands) && joinCommands.length && secure.isAvailable()) {
          const sealed = secure.encryptJson(joinCommands)
          // if encryption fails they stay in memory only, never in plain text
          return sealed ? { ...rest, joinCommands: [], joinCommandsSealed: sealed } : { ...rest, joinCommands: [] }
        }
        if ((!Array.isArray(joinCommands) || !joinCommands.length) && leftovers.has(s.id)) {
          return { ...rest, joinCommands: [], joinCommandsSealed: leftovers.get(s.id) }
        }
        return s
      })
    }
  }

  function fromDisk (data) {
    if (!data || !Array.isArray(data.servers)) return data
    return {
      ...data,
      servers: data.servers.map(s => {
        if (!s || typeof s.joinCommandsSealed !== 'string') return s
        const { joinCommandsSealed, ...rest } = s
        const commands = secure.decryptJson(joinCommandsSealed)
        if (Array.isArray(commands)) return { ...rest, joinCommands: commands.filter(c => typeof c === 'string') }
        if (typeof s.id === 'string') leftovers.set(s.id, joinCommandsSealed)
        return { ...rest, joinCommands: [] }
      })
    }
  }

  return { toDisk, fromDisk, forget: (id) => leftovers.delete(id) }
}

module.exports = { createJoinCommandsVault }
