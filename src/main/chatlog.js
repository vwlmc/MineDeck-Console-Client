'use strict'
// Optional chat logs (off by default). Plain text files on this computer only.
const fs = require('fs')
const path = require('path')

function pad (n) { return String(n).padStart(2, '0') }

class ChatLog {
  constructor (dir) {
    this.dir = dir
    this.buffer = []
    this.timer = null
  }

  write (line) {
    const d = new Date(line.time)
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const who = line.kind === 'sent' ? `${line.name} >` : `[${line.name}]`
    this.buffer.push({ day: stamp.slice(0, 10), text: `[${stamp}] ${who} ${line.text.replace(/[\r\n]+/g, ' ')}\n` })
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 1000)
  }

  flush () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.buffer.length) return
    const byDay = new Map()
    for (const { day, text } of this.buffer) byDay.set(day, (byDay.get(day) || '') + text)
    this.buffer = []
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      for (const [day, text] of byDay) fs.appendFileSync(path.join(this.dir, `chat-${day}.log`), text)
    } catch (e) {
      console.error('[chatlog]', e.message)
    }
  }
}

module.exports = { ChatLog }
