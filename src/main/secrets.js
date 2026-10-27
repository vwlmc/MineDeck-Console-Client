'use strict'
// Server login plugins (AuthMe, nLogin, LibreLogin, ...) take passwords as
// command arguments, for example "/login hunter2". MineDeck never shows,
// logs or remembers those arguments: the chat window and chat logs show
// "/login ••••••" instead.
const SECRET_COMMAND = /^(\/(?:login|log|l|register|reg|changepassword|changepass|cp|unregister|unreg|2fa|totp))(\s+)\S.*$/i

function isSecretCommand (text) {
  return SECRET_COMMAND.test(String(text).trim())
}

function maskSecrets (text) {
  return String(text).trim().replace(SECRET_COMMAND, (_m, cmd, space) => `${cmd}${space}••••••`)
}

module.exports = { isSecretCommand, maskSecrets, SECRET_COMMAND }
