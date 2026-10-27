'use strict'
// MineDeck compat module (see compat/README.md).
const crypto = require('crypto')
exports.v4 = () => crypto.randomUUID()
