'use strict'
// Turns Minecraft chat into a list of plain-text segments with style flags.
// The UI renders these with textContent only, so nothing a server sends can
// inject HTML or scripts.
//
// Segment: { t: text, c?: 'red' | '#rrggbb', b?: 1 bold, i?: 1 italic,
//            u?: 1 underline, s?: 1 strikethrough, o?: 1 obfuscated,
//            k?: { a: action, v: value } what clicking it does (run_command,
//                suggest_command, open_url, copy_to_clipboard), h?: hover text }

const NAMED_CODES = {
  0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red', 5: 'dark_purple', 6: 'gold', 7: 'gray',
  8: 'dark_gray', 9: 'blue', a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white'
}
const NAMED_COLORS = new Set(Object.values(NAMED_CODES))
const FORMAT_CODES = { k: 'o', l: 'b', m: 's', n: 'u', o: 'i' }
const MAX_TEXT = 4000
const MAX_SEGMENTS = 300
const MAX_DEPTH = 24
// a translation can reference the same argument many times; this caps the total
// work per message so a crafted message can't freeze MineDeck
const MAX_NODES = 5000

function sameStyle (a, b) {
  return a.c === b.c && a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.o === b.o &&
    a.k?.a === b.k?.a && a.k?.v === b.k?.v && a.h === b.h
}
const CLICK_ACTIONS = new Set(['run_command', 'suggest_command', 'open_url', 'copy_to_clipboard'])

class Builder {
  constructor () {
    this.segments = []
    this.length = 0
    this.nodes = 0
  }

  // false once the message is long enough or has used up its work budget
  more () {
    return this.length < MAX_TEXT && ++this.nodes <= MAX_NODES
  }

  add (text, style) {
    if (!text || this.length >= MAX_TEXT) return
    text = String(text).slice(0, MAX_TEXT - this.length)
    this.length += text.length
    const seg = { t: text }
    for (const k of ['c', 'b', 'i', 'u', 's', 'o', 'k', 'h']) if (style[k]) seg[k] = style[k]
    const last = this.segments[this.segments.length - 1]
    if (last && sameStyle(last, seg)) last.t += text
    else if (this.segments.length < MAX_SEGMENTS) this.segments.push(seg)
    else last.t += text
  }

  // text that may contain legacy "§" codes; codes apply on top of `base`
  addLegacy (str, base = {}) {
    str = String(str ?? '')
    let style = { ...base }
    const ev = { k: base.k, h: base.h } // click and hover survive colour codes
    let buf = ''
    const flush = () => { this.add(buf, style); buf = '' }
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]
      if (ch !== '§' || i + 1 >= str.length) { buf += ch; continue }
      const code = str[i + 1].toLowerCase()
      if (code === '#' && /^[0-9a-f]{6}$/i.test(str.slice(i + 2, i + 8))) { // prismarine-chat hex: §#rrggbb
        flush(); style = { ...ev, c: '#' + str.slice(i + 2, i + 8).toLowerCase() }; i += 7; continue
      }
      if (code === 'x' && /^§x(§[0-9a-f]){6}$/i.test(str.slice(i, i + 14))) { // Spigot hex: §x§r§r§g§g§b§b
        flush(); style = { ...ev, c: '#' + str.slice(i + 2, i + 14).replace(/§/g, '').toLowerCase() }; i += 13; continue
      }
      if (NAMED_CODES[code]) { flush(); style = { ...ev, c: NAMED_CODES[code] }; i++ } // colours reset formatting
      else if (FORMAT_CODES[code]) { flush(); style = { ...style, [FORMAT_CODES[code]]: 1 }; i++ }
      else if (code === 'r') { flush(); style = { ...base }; i++ }
      else buf += ch
    }
    flush()
  }
}

function flag (value, inherited) {
  if (value === true || value === 'true' || value === 1) return 1
  if (value === false || value === 'false' || value === 0) return 0
  return inherited || 0
}

function colorOf (value, inherited) {
  if (typeof value !== 'string') return inherited
  const v = value.toLowerCase()
  if (NAMED_COLORS.has(v)) return v
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (v === 'reset') return undefined
  return inherited
}

// Minecraft translation strings use %s, %1$s and %%
function formatTranslation (format, args, style, out, lang, depth) {
  let index = 0
  let last = 0
  const re = /%(?:(\d+)\$)?([sd%])/g
  let m
  while ((m = re.exec(format)) !== null) {
    out.addLegacy(format.slice(last, m.index), style)
    last = re.lastIndex
    if (m[2] === '%') { out.add('%', style); continue }
    const argIndex = m[1] ? Number(m[1]) - 1 : index++
    const arg = args[argIndex]
    if (arg !== undefined) walk(arg, style, out, lang, depth + 1)
  }
  out.addLegacy(format.slice(last), style)
}

// clickEvent (JSON, up to 1.21.4) or click_event (1.21.5+)
function clickOf (node, inherited) {
  const ev = node.clickEvent || node.click_event
  if (!ev || typeof ev !== 'object' || !CLICK_ACTIONS.has(ev.action)) return inherited
  const v = ev.value ?? ev.command ?? ev.url
  if (typeof v !== 'string' && typeof v !== 'number') return inherited
  return { a: ev.action, v: String(v).slice(0, 512) }
}

// hover text (show_text) as plain text; shares the message's work budget
function hoverOf (node, inherited, out, lang, depth) {
  const ev = node.hoverEvent || node.hover_event
  if (!ev || typeof ev !== 'object' || ev.action !== 'show_text') return inherited
  const content = ev.contents ?? ev.value
  if (content == null) return inherited
  const sub = new Builder()
  sub.nodes = out.nodes
  walk(content, {}, sub, lang, depth + 1)
  out.nodes = sub.nodes
  const text = sub.segments.map(s => s.t).join('').trim().slice(0, 300)
  return text || inherited
}

function walk (node, inherited, out, lang, depth) {
  if (node == null || depth > MAX_DEPTH || !out.more()) return
  if (typeof node === 'string' || typeof node === 'number') { out.addLegacy(String(node), inherited); return }
  if (Array.isArray(node)) { for (const n of node) walk(n, inherited, out, lang, depth + 1); return }
  if (typeof node !== 'object') return
  const style = {
    c: colorOf(node.color, inherited.c),
    b: flag(node.bold, inherited.b),
    i: flag(node.italic, inherited.i),
    u: flag(node.underlined, inherited.u),
    s: flag(node.strikethrough, inherited.s),
    o: flag(node.obfuscated, inherited.o),
    k: clickOf(node, inherited.k),
    h: hoverOf(node, inherited.h, out, lang, depth)
  }
  if (typeof node.text === 'string' || typeof node.text === 'number') {
    out.addLegacy(String(node.text), style)
  } else if (typeof node[''] === 'string') { // NBT text components can use an empty key
    out.addLegacy(node[''], style)
  } else if (typeof node.translate === 'string') {
    let format = lang && typeof lang[node.translate] === 'string' ? lang[node.translate] : null
    if (format === null) format = typeof node.fallback === 'string' ? node.fallback : node.translate
    const args = Array.isArray(node.with) ? node.with : []
    formatTranslation(format, args, style, out, lang, depth)
  } else if (typeof node.selector === 'string') {
    out.add(node.selector, style)
  } else if (typeof node.keybind === 'string') {
    out.add(node.keybind, style)
  } else if (node.score && typeof node.score === 'object') {
    out.add(String(node.score.value ?? node.score.name ?? ''), style)
  }
  if (Array.isArray(node.extra)) for (const e of node.extra) walk(e, style, out, lang, depth + 1)
}

/** Any chat component (prismarine-chat ChatMessage, parsed JSON, or string) -> segments */
function toSegments (component, lang) {
  const out = new Builder()
  walk(component, {}, out, lang, 0)
  return out.segments
}

/** Legacy "§" text -> segments */
function parseLegacy (text) {
  const out = new Builder()
  out.addLegacy(text)
  return out.segments
}

function plainText (segments) {
  return segments.map(s => s.t).join('')
}

module.exports = { toSegments, parseLegacy, plainText }
