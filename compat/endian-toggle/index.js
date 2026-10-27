'use strict'
// MineDeck compat module (see compat/README.md).
module.exports = function endianToggle (buf, bits) {
  const bytes = bits / 8
  if (!Number.isInteger(bytes) || bytes < 1) throw new Error('bits must be a positive multiple of 8')
  if (buf.length % bytes !== 0) throw new Error('buffer length must be a multiple of ' + bytes)
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i += bytes) {
    for (let j = 0; j < bytes; j++) out[i + bytes - j - 1] = buf[i + j]
  }
  return out
}
