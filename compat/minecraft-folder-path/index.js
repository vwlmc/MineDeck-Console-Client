'use strict'
// MineDeck compat module (see compat/README.md).
const os = require('os')
const path = require('path')

function minecraftFolder () {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft')
    default:
      return path.join(os.homedir(), '.minecraft')
  }
}
module.exports = minecraftFolder()
