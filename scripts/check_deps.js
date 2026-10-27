#!/usr/bin/env node
'use strict'
// Checks that the installed libraries are the ones MineDeck was tested with.
// MineDeck pins mineflayer and minecraft-protocol to specific GitHub commits
// (see package.json and scripts/assemble_deps.py for why); this makes sure the
// install really contains those fixes and that only one copy of
// minecraft-protocol is used.
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const problems = []
const resolve = (name, from) => path.dirname(require.resolve(`${name}/package.json`, { paths: [from] }))

const protocolDir = resolve('minecraft-protocol', root)
const mineflayerDir = resolve('mineflayer', root)
if (resolve('minecraft-protocol', mineflayerDir) !== protocolDir) {
  problems.push('mineflayer uses a different copy of minecraft-protocol than MineDeck')
}

const has = (dir, file, text) => {
  try { return fs.readFileSync(path.join(dir, file), 'utf8').includes(text) } catch { return false }
}
if (!has(protocolDir, 'src/client/play.js', 'particleStatus')) problems.push('minecraft-protocol lacks the 1.21.2+ client settings fix')
if (!has(protocolDir, 'src/transforms/compression.js', 'MAX_UNCOMPRESSED_LENGTH')) problems.push('minecraft-protocol lacks the decompression size limit')
if (!has(mineflayerDir, 'lib/loader.js', "require('./plugins/abilities')")) problems.push('mineflayer is older than the pinned commit')

const data = require(resolve('minecraft-data', root) + '/package.json')
for (const v of ['1.7.10', '1.8.9', '1.12.2', '1.20.4', '1.21.11', '26.1.2']) {
  if (!require(resolve('minecraft-data', root))(v)) problems.push(`minecraft-data ${data.version} has no data for ${v}`)
}

if (problems.length) {
  console.error('Dependency check failed:\n - ' + problems.join('\n - '))
  process.exit(1)
}
console.log('Dependency check passed.')
