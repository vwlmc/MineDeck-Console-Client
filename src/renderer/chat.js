// The chat window: renders chat segments, merges the same message received by
// several accounts into one line, filters by account, search and auto-scroll.
import { h, clear, clock, nameHue } from './ui.js'
import { icon } from './icons.js'

const MERGE_WINDOW_MS = 6000
const NAMED = new Set(['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'])
const HEX = /^#[0-9a-f]{6}$/

/**
 * @param {Array} segments
 * @param {string} fallbackText
 * @param {(click: {a: string, v: string}) => void} [onClick]  makes clickable text (server "[Click here]" buttons) work
 */
export function renderSegments (segments, fallbackText, onClick) {
  const frag = document.createDocumentFragment()
  if (!segments || !segments.length) {
    frag.appendChild(document.createTextNode(fallbackText || ''))
    return frag
  }
  for (const s of segments) {
    const span = document.createElement('span')
    span.textContent = s.t
    if (s.c) {
      if (NAMED.has(s.c)) span.classList.add('mc-' + s.c)
      else if (HEX.test(s.c)) span.style.color = s.c
    }
    if (s.b) span.classList.add('mc-b')
    if (s.i) span.classList.add('mc-i')
    if (s.u) span.classList.add('mc-u')
    if (s.s) span.classList.add('mc-s')
    if (s.o) span.classList.add('mc-o')
    if (s.h) span.title = s.h
    if (s.k && onClick) {
      span.classList.add('mc-click')
      if (!s.h) span.title = clickHint(s.k)
      span.addEventListener('click', (e) => { e.stopPropagation(); onClick(s.k) })
    }
    frag.appendChild(span)
  }
  return frag
}

export function clickHint (k) {
  if (k.a === 'run_command') return `Click to run ${k.v}`
  if (k.a === 'suggest_command') return `Click to put ${k.v} in the message box`
  if (k.a === 'open_url') return `Click to copy the link ${k.v}`
  return 'Click to copy'
}

export class ChatView {
  constructor (container, { getFilter, getSettings, isMention, accountName, onUnreadChange, onClick }) {
    this.onClick = onClick || null
    this.container = container
    this.getFilter = getFilter
    this.getSettings = getSettings
    this.isMention = isMention
    this.accountName = accountName
    this.onUnreadChange = onUnreadChange || (() => {})
    this.lines = [] // every line we know about (capped)
    this.recent = new Map() // merge key -> { el, names, accs, time }
    this.stick = true
    this.unread = 0
    this.visibleCount = 0
    container.addEventListener('scroll', () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40
      if (atBottom !== this.stick) {
        this.stick = atBottom
        if (atBottom) { this.unread = 0; this.onUnreadChange(0) }
      }
    })
  }

  maxLines () {
    return this.getSettings().chatMaxLines || 3000
  }

  setHistory (lines) {
    this.lines = lines.slice(-this.maxLines())
    this.rerender()
  }

  add (batch) {
    this.lines.push(...batch)
    const max = this.maxLines()
    if (this.lines.length > max) this.lines.splice(0, this.lines.length - max)
    let added = 0
    for (const line of batch) if (this._renderLine(line)) added++
    this._trimDom()
    if (added) {
      if (this.stick) this.scrollToEnd()
      else { this.unread += added; this.onUnreadChange(this.unread) }
    }
  }

  clear () {
    this.lines = []
    this.rerender()
  }

  rerender () {
    clear(this.container)
    this.recent.clear()
    this.visibleCount = 0
    const lines = this.lines.slice(-Math.min(this.maxLines(), 2500))
    for (const line of lines) this._renderLine(line)
    if (!this.visibleCount) this.container.appendChild(this._emptyState())
    this.scrollToEnd()
  }

  scrollToEnd () {
    this.container.scrollTop = this.container.scrollHeight
    this.stick = true
    this.unread = 0
    this.onUnreadChange(0)
  }

  _emptyState () {
    const f = this.getFilter()
    return h('div', { class: 'chat-empty' },
      icon('chat', 28),
      h('div', { text: f.search ? 'No messages match your search.' : 'Chat from your accounts will show up here.' }))
  }

  _passes (line) {
    const f = this.getFilter()
    const s = this.getSettings()
    if (line.kind === 'event' && !s.chatShowEvents) return false
    if (f.view === 'selected') {
      if (!f.selected.has(line.acc)) return false
    } else if (f.view !== 'all' && line.acc !== f.view) return false
    if (f.search && !line.text.toLowerCase().includes(f.search) && !String(line.name).toLowerCase().includes(f.search)) return false
    return true
  }

  _renderLine (line) {
    if (!this._passes(line)) return false
    const f = this.getFilter()
    const s = this.getSettings()
    const empty = this.container.querySelector('.chat-empty')
    if (empty) empty.remove()

    // the same message seen by several accounts becomes one line
    const canMerge = line.kind === 'chat' && s.chatMergeDuplicates && f.view !== line.acc
    if (canMerge) {
      const key = line.text
      const prev = this.recent.get(key)
      if (prev && line.time - prev.time < MERGE_WINDOW_MS && !prev.accs.has(line.acc) && prev.el.isConnected) {
        prev.accs.add(line.acc)
        prev.names.push(line.name)
        prev.count.textContent = `×${prev.accs.size}`
        prev.count.hidden = false
        prev.el.title = `Seen by ${prev.names.join(', ')}`
        return false
      }
    }

    const el = h('div', { class: `line kind-${line.kind}${line.level ? ' lvl-' + line.level : ''}` })
    if (s.chatTimestamps) el.appendChild(h('span', { class: 'ts', text: clock(line.time) }))
    if (line.kind === 'event') {
      el.appendChild(h('span', { class: 'ev-icon' }, icon(line.level === 'good' ? 'check' : line.level === 'error' || line.level === 'warn' ? 'alert' : 'bolt', 12)))
      el.appendChild(h('span', { class: 'msg', text: line.text }))
    } else {
      const who = h('span', { class: 'who', text: line.name, style: { '--hue': String(nameHue(line.name)) } })
      who.style.setProperty('--hue', String(nameHue(line.name)))
      el.appendChild(who)
      const count = h('span', { class: 'dup', hidden: true })
      el.appendChild(count)
      if (line.kind === 'sent') el.appendChild(h('span', { class: 'arrow' }, icon('send', 11)))
      const msg = h('span', { class: 'msg' })
      const accs = new Set([line.acc]) // grows when other accounts see the same message
      msg.appendChild(renderSegments(line.seg, line.text, this.onClick && line.kind === 'chat' ? (k) => this.onClick(k, [...accs], el) : null))
      el.appendChild(msg)
      if (line.kind === 'chat' && this.isMention(line.text)) el.classList.add('mention')
      if (canMerge) {
        this.recent.set(line.text, { el, count, names: [line.name], accs, time: line.time })
        if (this.recent.size > 400) this.recent.delete(this.recent.keys().next().value)
      }
    }
    this.container.appendChild(el)
    this.visibleCount++
    return true
  }

  _trimDom () {
    const max = Math.min(this.maxLines(), 2500)
    let extra = this.container.childElementCount - max
    while (extra-- > 0 && this.container.firstElementChild) this.container.firstElementChild.remove()
  }
}
