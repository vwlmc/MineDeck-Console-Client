'use strict'
// Downloads a player's skin (to show their face in the account list).
// Only Mojang's own servers are contacted: sessionserver.mojang.com and
// textures.minecraft.net. No token is needed or sent.
const fs = require('fs')
const path = require('path')

const TEXTURE_RE = /^https?:\/\/textures\.minecraft\.net\/texture\/[0-9a-f]{16,80}$/i
const UUID_RE = /^[0-9a-f]{32}$/i
const MAX_BYTES = 64 * 1024
const FRESH_MS = 24 * 3600 * 1000
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function fetchBuffer (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('too large')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('too large')
  return buf
}

async function textureUrlFor (uuid) {
  const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) return null
  const data = await res.json()
  const prop = (data.properties || []).find(p => p.name === 'textures')
  if (!prop) return null
  const textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'))
  return textures?.textures?.SKIN?.url || null
}

/** Returns "data:image/png;base64,..." for the account's skin, or null. */
async function getSkin (cacheDir, uuid, knownUrl) {
  uuid = String(uuid || '').replace(/-/g, '')
  if (!UUID_RE.test(uuid)) return null
  const file = path.join(cacheDir, `${uuid.toLowerCase()}.png`)
  try {
    const st = fs.statSync(file)
    if (Date.now() - st.mtimeMs < FRESH_MS) return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
  } catch { }
  try {
    let url = typeof knownUrl === 'string' && TEXTURE_RE.test(knownUrl) ? knownUrl : await textureUrlFor(uuid)
    if (!url || !TEXTURE_RE.test(url)) return null
    url = url.replace(/^http:/, 'https:')
    const png = await fetchBuffer(url)
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) return null
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(file, png)
    return 'data:image/png;base64,' + png.toString('base64')
  } catch {
    // offline or rate-limited: fall back to a stale copy if we have one
    try { return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64') } catch { return null }
  }
}

module.exports = { getSkin }
