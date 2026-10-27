// Small DOM helpers. Everything is built with createElement/textContent:
// no innerHTML anywhere, so text from servers can never become HTML.

export function h (tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, String(v))
  }
  append(el, children)
  return el
}

export function append (el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

export function clear (el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

export function svg (paths, size = 16, extra = {}) {
  const NS = 'http://www.w3.org/2000/svg'
  const s = document.createElementNS(NS, 'svg')
  s.setAttribute('viewBox', '0 0 24 24')
  s.setAttribute('width', size)
  s.setAttribute('height', size)
  s.setAttribute('fill', 'none')
  s.setAttribute('stroke', 'currentColor')
  s.setAttribute('stroke-width', extra.strokeWidth || '2')
  s.setAttribute('stroke-linecap', 'round')
  s.setAttribute('stroke-linejoin', 'round')
  s.setAttribute('aria-hidden', 'true')
  s.classList.add('icon')
  for (const d of paths) {
    if (typeof d === 'string') {
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', d)
      s.appendChild(p)
    } else {
      const el = document.createElementNS(NS, d.tag)
      for (const [k, v] of Object.entries(d)) if (k !== 'tag') el.setAttribute(k, v)
      s.appendChild(el)
    }
  }
  return s
}

const pad = (n) => String(n).padStart(2, '0')

export function clock (ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function duration (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  const hr = Math.floor(m / 60)
  if (hr < 48) return `${hr}h ${pad(m % 60)}m`
  return `${Math.floor(hr / 24)}d ${hr % 24}h`
}

// a stable, readable colour for each account name
export function nameHue (name) {
  let hash = 0
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return hash % 360
}

export function debounce (fn, ms) {
  let t = null
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

export function store (key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify(value))
  } catch { return null }
}
