'use strict'
// App settings: defaults plus strict validation of anything coming from the UI.
const { findVersion } = require('./versions')

const DEFAULT_SETTINGS = {
  // connecting
  loginDelaySec: 5, // wait between account logins so the server isn't flooded
  loginJitterSec: 2, // extra random wait (0 - n seconds) on top of the delay
  connectTimeoutSec: 30,
  autoReconnect: true,
  reconnectDelaySec: 15, // first retry; doubles after each failure
  reconnectMaxDelaySec: 300,
  reconnectMaxAttempts: 0, // 0 = keep trying
  reconnectStopWords: ['banned', 'blacklisted', 'not whitelisted', 'logged in from another location'],
  // in game
  autoRespawn: true,
  acceptResourcePacks: true,
  antiAfk: 'off', // off | swing | look | jump | sneak
  antiAfkIntervalSec: 60,
  viewDistance: 'tiny', // tiny | short | normal | far
  joinCommandDelaySec: 2,
  // chat
  sendDelayMs: 300, // stagger when one message is sent from several accounts
  chatMaxLines: 3000,
  chatTimestamps: true,
  chatMergeDuplicates: true,
  chatShowActionBar: false,
  chatShowEvents: true,
  highlightWords: [],
  notifyOnMention: true,
  saveChatLogs: false,
  // app
  minimizeToTray: false,
  keepAwake: true,
  launchAtLogin: false, // start MineDeck when you sign in to Windows / macOS
  resumeOnStart: false // reconnect accounts that were online when MineDeck closed
}

const ENUMS = {
  antiAfk: ['off', 'swing', 'look', 'jump', 'sneak'],
  viewDistance: ['tiny', 'short', 'normal', 'far']
}
const RANGES = {
  loginDelaySec: [0, 600],
  loginJitterSec: [0, 120],
  connectTimeoutSec: [5, 120],
  reconnectDelaySec: [1, 3600],
  reconnectMaxDelaySec: [1, 86400],
  reconnectMaxAttempts: [0, 10000],
  antiAfkIntervalSec: [5, 3600],
  joinCommandDelaySec: [0, 60],
  sendDelayMs: [0, 10000],
  chatMaxLines: [200, 50000]
}

function cleanWordList (value, maxItems = 50, maxLen = 64) {
  if (!Array.isArray(value)) return null
  return value
    .filter(v => typeof v === 'string')
    .map(v => v.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems)
}

/** Returns a new settings object with only valid values from `patch` applied. */
function applySettingsPatch (current, patch) {
  const next = { ...DEFAULT_SETTINGS, ...current }
  if (!patch || typeof patch !== 'object') return next
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue // also rejects "__proto__", "constructor", ...
    const def = DEFAULT_SETTINGS[key]
    if (Object.hasOwn(RANGES, key)) {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      const [min, max] = RANGES[key]
      next[key] = Math.min(max, Math.max(min, Math.round(n * 10) / 10))
    } else if (Object.hasOwn(ENUMS, key)) {
      if (ENUMS[key].includes(value)) next[key] = value
    } else if (typeof def === 'boolean') {
      if (typeof value === 'boolean') next[key] = value
    } else if (Array.isArray(def)) {
      const list = cleanWordList(value)
      if (list) next[key] = list
    }
  }
  if (next.reconnectMaxDelaySec < next.reconnectDelaySec) next.reconnectMaxDelaySec = next.reconnectDelaySec
  return next
}

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/

/** Accepts "host", "host:port", "[ipv6]:port". Returns { host, port } or null. */
function parseAddress (input, fallbackPort = 25565) {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (!s || s.length > 260) return null
  s = s.replace(/^minecraft:\/\//i, '')
  let host = s
  let port = fallbackPort
  const v6 = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/)
  if (v6) {
    host = v6[1]
    if (v6[2]) port = Number(v6[2])
    if (!IPV6_RE.test(host)) return null
  } else {
    const m = s.match(/^([^:]+)(?::(\d{1,5}))?$/)
    if (!m) return null
    host = m[1]
    if (m[2]) port = Number(m[2])
    if (!HOST_RE.test(host) || host.length > 253) return null
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

/** Validates a server profile from the UI. Returns a clean object or throws. */
function cleanServer (input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid server')
  const addr = parseAddress(String(input.address ?? `${input.host ?? ''}${input.port ? ':' + input.port : ''}`))
  if (!addr) throw new Error('That server address is not valid. Use something like play.example.com or play.example.com:25566')
  const version = typeof input.version === 'string' && (input.version === 'auto' || findVersion(input.version)) ? input.version : 'auto'
  const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : addr.host).slice(0, 40)
  const joinCommands = (Array.isArray(input.joinCommands) ? input.joinCommands : String(input.joinCommands || '').split('\n'))
    .filter(v => typeof v === 'string')
    .map(v => v.trim().slice(0, 256))
    .filter(Boolean)
    .slice(0, 20)
  return { name, host: addr.host, port: addr.port, version, joinCommands }
}

module.exports = { DEFAULT_SETTINGS, ENUMS, RANGES, applySettingsPatch, parseAddress, cleanServer }
