'use strict'
// Which Minecraft: Java Edition versions MineDeck can join, and how to pick the
// right protocol data for each of them.
const mcData = require('minecraft-data')

const OLDEST = '1.7.10'
const NEWEST = '26.1.2'
const RELEASE = /^\d+\.\d+(\.\d+)?$/

function cmp (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

let cache = null

/**
 * Every release from 1.7.10 to 26.1.2, newest first:
 *   { id: '1.20.4', protocol: 765, dataVersion: '1.20.4', engine: 'mineflayer' | 'legacy' }
 * dataVersion is the protocol definition that matches the release exactly
 * (several releases share one protocol, e.g. 1.20.3 and 1.20.4).
 */
function listVersions () {
  if (cache) return cache
  const all = mcData.versions.pc.filter(v => RELEASE.test(v.minecraftVersion) && v.usesNetty)
  // protocol data sets that actually exist in minecraft-data
  const dataSets = new Map() // protocol -> [minecraftVersion of data set]
  for (const v of all) {
    const d = mcData(v.minecraftVersion)
    if (!d || !d.protocol || d.version.version !== v.version) continue
    const key = d.version.minecraftVersion
    if (!dataSets.has(v.version)) dataSets.set(v.version, new Set())
    dataSets.get(v.version).add(key)
  }
  const out = []
  const seen = new Set()
  for (const v of all) {
    const id = v.minecraftVersion
    if (seen.has(id) || cmp(id, OLDEST) < 0 || cmp(id, NEWEST) > 0) continue
    seen.add(id)
    const sets = dataSets.get(v.version)
    if (!sets || !sets.size) continue
    const dataVersion = sets.has(id) ? id : [...sets].sort(cmp).pop()
    out.push({ id, protocol: v.version, dataVersion, engine: cmp(id, '1.8') < 0 ? 'legacy' : 'mineflayer' })
  }
  out.sort((a, b) => cmp(b.id, a.id))
  cache = out
  return out
}

function findVersion (id) {
  return listVersions().find(v => v.id === id) || null
}

// newest release we support for a protocol number (used by auto-detect)
function versionForProtocol (protocol) {
  return listVersions().find(v => v.protocol === protocol) || null
}

module.exports = { listVersions, findVersion, versionForProtocol, OLDEST, NEWEST, cmpVersions: cmp }
