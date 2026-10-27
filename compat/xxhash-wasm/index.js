'use strict'
// MineDeck compat module (see compat/README.md).
// prismarine-chunk loads its Bedrock Edition code (which hashes chunk blobs
// with xxhash-wasm) together with its Java Edition code. MineDeck only joins
// Java Edition servers, so the hasher is never needed.
module.exports = function xxhash () {
  return Promise.reject(new Error('xxhash-wasm is not bundled with MineDeck (only used for Bedrock Edition chunks).'))
}
