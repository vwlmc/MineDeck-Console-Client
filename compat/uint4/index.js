'use strict'
// MineDeck compat module (see compat/README.md).
// Little-endian nibble order, like Minecraft's NibbleArray: a whole-number
// cursor addresses the low 4 bits of that byte, cursor + 0.5 the high 4 bits.
function readUInt4LE (buf, cursor) {
  const i = Math.floor(cursor)
  return cursor % 1 === 0 ? buf[i] & 0x0f : (buf[i] >> 4) & 0x0f
}

function writeUInt4LE (buf, value, cursor) {
  const i = Math.floor(cursor)
  if (cursor % 1 === 0) buf[i] = (buf[i] & 0xf0) | (value & 0x0f)
  else buf[i] = (buf[i] & 0x0f) | ((value & 0x0f) << 4)
}

module.exports = { readUInt4LE, writeUInt4LE }
