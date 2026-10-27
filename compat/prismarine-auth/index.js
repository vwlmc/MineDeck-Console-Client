'use strict'
// MineDeck compat module (see compat/README.md).
// minecraft-protocol imports prismarine-auth when it loads (for its built-in
// "microsoft" auth mode). MineDeck never uses that mode: it signs in with its
// own device-code code in src/main/auth and hands the result to the client.
class Authflow {
  constructor () {
    throw new Error('prismarine-auth is not bundled with MineDeck. Sign-in is handled by MineDeck itself.')
  }
}
const Titles = {
  MinecraftNintendoSwitch: '00000000441cc96b',
  MinecraftJava: '00000000402b5328'
}
module.exports = { Authflow, Titles }
