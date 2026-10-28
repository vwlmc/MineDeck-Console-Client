'use strict'
// Test helper: makes every library that uses node-fetch (yggdrasil, for Mojang's
// session server) send its requests through globalThis.fetch, so a test can stub
// all network calls in one place. The hand-built offline tree already works this
// way (compat/node-fetch); a normal npm install has the real node-fetch, which
// opens its own connections and would reach the real Mojang servers instead.
// Require this before anything that loads minecraft-protocol.
const Module = require('module')

function fetch (url, options) {
  return globalThis.fetch(url, options)
}
fetch.default = fetch
fetch.Headers = globalThis.Headers
fetch.Request = globalThis.Request
fetch.Response = globalThis.Response
fetch.FetchError = class FetchError extends Error {}

const load = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') return fetch
  return load.call(this, request, parent, isMain)
}
