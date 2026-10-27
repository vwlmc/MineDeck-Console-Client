'use strict'
// Small JSON file store with atomic writes (write to a temp file, then rename),
// so a crash or power cut can't leave a half-written file behind.
const fs = require('fs')
const path = require('path')

class JsonFile {
  /**
   * @param {string} file
   * @param {object} defaults
   * @param {{ toDisk?: (data: object) => object, fromDisk?: (data: object) => object }} [hooks]
   *   optional transforms applied when writing / reading (used to encrypt fields)
   */
  constructor (file, defaults, hooks = {}) {
    this.file = file
    this.defaults = defaults
    this.toDisk = hooks.toDisk || ((d) => d)
    this.fromDisk = hooks.fromDisk || ((d) => d)
    this.data = null
    this._timer = null
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      this.data = this.fromDisk({ ...structuredClone(this.defaults), ...parsed })
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // keep a copy of an unreadable file instead of silently overwriting it
        try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { }
      }
      this.data = structuredClone(this.defaults)
    }
    return this.data
  }

  saveNow () {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeSync(fd, JSON.stringify(this.toDisk(this.data), null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, this.file)
    try { fs.chmodSync(this.file, 0o600) } catch { }
  }

  // coalesce bursts of changes into one write
  save (delayMs = 250) {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      try { this.saveNow() } catch (e) { console.error('[store] save failed:', e.message) }
    }, delayMs)
  }

  flush () {
    if (this._timer) this.saveNow()
  }
}

module.exports = { JsonFile }
