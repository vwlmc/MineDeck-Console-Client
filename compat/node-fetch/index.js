'use strict'
// MineDeck compat module (see compat/README.md).
// node-fetch v2 and the fetch() built into Node.js implement the same WHATWG
// Fetch API for the calls made by the bundled libraries (POST/GET with JSON
// bodies, reading .status / .text() / .json()).
function fetch (url, options) {
  return globalThis.fetch(url, options)
}
module.exports = fetch
module.exports.default = fetch
module.exports.Headers = globalThis.Headers
module.exports.Request = globalThis.Request
module.exports.Response = globalThis.Response
module.exports.FetchError = class FetchError extends Error {}
