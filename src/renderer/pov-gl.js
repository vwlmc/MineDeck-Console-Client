// POV 3D view: draws the blocks and entities around the watched account with
// WebGL 2. There are no Minecraft textures here (they belong to Mojang): every
// block is a coloured shape, shaded by face direction and ambient occlusion.

export const KIND = { AIR: 0, SOLID: 1, GLASS: 2, LIQUID: 3, SLAB: 4, THIN: 5, PLANT: 6, POST: 7, BOX: 8 }

const P = 18 // a section padded with one block of its neighbours on each side
const PI2 = Math.PI * 2
const AO = [0.5, 0.68, 0.84, 1]
const sectionKey = (cx, cy, cz) => `${cx},${cy},${cz}`

// how mobs are drawn: humanoids (skin, body, legs), four-legged animals (body, head) or one box
const H = (skin, body, legs, head) => ({ model: 'humanoid', skin, body, legs, head })
const Q = (body, head, leg, legs) => ({ model: 'quad', body, head, leg, legs })
const B = (body) => ({ model: 'box', body })
const MOBS = {
  zombie: H([95, 150, 85], [50, 120, 160], [60, 60, 140]),
  husk: H([190, 170, 120], [150, 130, 90], [110, 100, 80]),
  drowned: H([90, 160, 150], [70, 130, 120], [60, 100, 110]),
  zombie_villager: H([95, 150, 85], [110, 80, 60], [90, 70, 50]),
  skeleton: H([214, 214, 214], [200, 200, 200], [180, 180, 180]),
  stray: H([180, 200, 200], [150, 170, 175], [130, 150, 155]),
  bogged: H([170, 180, 140], [120, 140, 90], [110, 120, 80]),
  wither_skeleton: H([50, 50, 50], [40, 40, 40], [35, 35, 35]),
  villager: H([190, 140, 110], [120, 90, 60], [100, 75, 50]),
  wandering_trader: H([190, 140, 110], [40, 70, 140], [40, 60, 120]),
  witch: H([150, 170, 120], [80, 40, 90], [70, 35, 80], [60, 40, 70]),
  pillager: H([150, 150, 150], [60, 60, 65], [50, 50, 55]),
  vindicator: H([150, 150, 150], [50, 60, 70], [40, 40, 45]),
  evoker: H([150, 150, 150], [40, 40, 50], [30, 30, 40]),
  piglin: H([230, 160, 150], [120, 80, 50], [100, 70, 45]),
  piglin_brute: H([230, 160, 150], [90, 60, 40], [70, 50, 35]),
  zombified_piglin: H([200, 140, 130], [90, 130, 80], [100, 70, 45]),
  enderman: H([22, 22, 28], [22, 22, 28], [22, 22, 28]),
  creeper: H([80, 170, 70], [80, 170, 70], [70, 150, 60]),
  iron_golem: H([210, 205, 195], [200, 195, 185], [190, 185, 175]),
  snow_golem: H([245, 250, 250], [245, 250, 250], [245, 250, 250], [230, 140, 40]),
  blaze: H([250, 180, 40], [240, 160, 30], [230, 140, 20]),
  armor_stand: H([160, 130, 90], [160, 130, 90], [150, 120, 80]),
  sheep: Q([232, 232, 232], [210, 190, 170]),
  cow: Q([90, 60, 40], [70, 50, 35]),
  mooshroom: Q([160, 40, 40], [150, 40, 40]),
  pig: Q([240, 170, 170], [240, 160, 160], null, 0.3),
  horse: Q([140, 100, 60], [130, 90, 55]),
  donkey: Q([120, 105, 90], [110, 95, 80]),
  mule: Q([100, 80, 60], [90, 70, 55]),
  llama: Q([220, 210, 180], [210, 200, 170]),
  trader_llama: Q([220, 210, 180], [60, 80, 160]),
  wolf: Q([210, 210, 210], [200, 200, 200]),
  fox: Q([220, 120, 50], [230, 140, 70]),
  cat: Q([230, 180, 90], [230, 180, 90]),
  ocelot: Q([230, 190, 100], [230, 190, 100]),
  goat: Q([230, 230, 220], [220, 220, 210]),
  polar_bear: Q([240, 240, 240], [235, 235, 235]),
  panda: Q([240, 240, 240], [240, 240, 240], [40, 40, 40]),
  spider: Q([50, 45, 40], [60, 30, 30], [40, 35, 30], 0.3),
  cave_spider: Q([30, 60, 70], [50, 30, 30], [25, 50, 60], 0.3),
  turtle: Q([60, 140, 70], [80, 160, 90], null, 0.15),
  rabbit: Q([160, 120, 90], [160, 120, 90]),
  frog: Q([190, 120, 60], [190, 120, 60], null, 0.2),
  armadillo: Q([170, 110, 110], [170, 110, 110], null, 0.2),
  camel: Q([210, 170, 110], [200, 160, 100]),
  sniffer: Q([150, 60, 50], [100, 160, 80]),
  hoglin: Q([180, 110, 90], [190, 120, 100]),
  zoglin: Q([200, 150, 150], [210, 160, 160]),
  strider: Q([160, 50, 50], [160, 50, 50], null, 0.5),
  axolotl: Q([240, 160, 200], [240, 160, 200], null, 0.2),
  chicken: B([245, 245, 245]),
  bat: B([60, 50, 40]),
  parrot: B([200, 40, 40]),
  bee: B([240, 200, 60]),
  slime: B([110, 190, 90]),
  magma_cube: B([150, 50, 20]),
  ghast: B([245, 245, 245]),
  squid: B([60, 80, 120]),
  glow_squid: B([40, 140, 140]),
  dolphin: B([120, 140, 160]),
  guardian: B([100, 150, 130]),
  elder_guardian: B([200, 200, 180]),
  phantom: B([60, 70, 120]),
  allay: B([80, 180, 240]),
  vex: B([150, 170, 200]),
  silverfish: B([140, 140, 140]),
  endermite: B([60, 40, 80]),
  shulker: B([150, 100, 150]),
  wither: B([30, 30, 30]),
  ender_dragon: B([25, 20, 30]),
  breeze: B([170, 180, 230]),
  warden: B([20, 50, 60]),
  boat: B([150, 115, 70]),
  minecart: B([150, 150, 160]),
  item_frame: B([150, 115, 70]),
  painting: B([150, 115, 70])
}

// ------------------------------------------------------------------ math
function perspective (fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0])
}

function multiply (a, b) {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
  }
  return o
}

// camera at the origin looking along f (rotation only: positions are camera-relative)
function lookDir (f) {
  const z = [-f[0], -f[1], -f[2]]
  let x = [z[2], 0, -z[0]] // cross((0,1,0), z)
  const xl = Math.hypot(x[0], x[2]) || 1
  x = [x[0] / xl, 0, x[2] / xl]
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1])
}

/** mineflayer angles -> unit view direction (yaw 0 = north/-Z, counter-clockwise; pitch up is positive) */
export function direction (yaw, pitch) {
  const c = Math.cos(pitch)
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c]
}

export function hsl (h, s, l) {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

export function hashName (s) {
  let h = 0
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h
}

// ------------------------------------------------------------------ faces
// n: outward normal, u/v: the face's two edge directions, shade: light from that side
const FACE_DEFS = [
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 1 },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.5 },
  { n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.62 },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.62 },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.8 },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.8 }
]
const pd = (x, y, z) => (y * P + z) * P + x
const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]]
const FACES = FACE_DEFS.map(f => {
  const base = f.n.map(c => (c > 0 ? 1 : 0))
  const corners = CORNER_UV.map(([a, b]) => [0, 1, 2].map(i => base[i] + a * f.u[i] + b * f.v[i]))
  const nd = pd(...f.n)
  const ud = pd(...f.u)
  const vd = pd(...f.v)
  const ao = CORNER_UV.map(([a, b]) => {
    const su = a ? ud : -ud
    const sv = b ? vd : -vd
    return [nd + su, nd + sv, nd + su + sv]
  })
  return { ...f, corners, nd, ao }
})

// growable vertex buffer: x y z (float32) + r g b a (bytes) = 16 bytes per vertex
class VertexBuffer {
  constructor (cap = 1 << 14) {
    this.alloc(cap)
    this.n = 0
  }

  alloc (cap) {
    const old = this.u
    this.cap = cap
    this.ab = new ArrayBuffer(cap * 16)
    this.f = new Float32Array(this.ab)
    this.u = new Uint8Array(this.ab)
    if (old) this.u.set(old.subarray(0, this.n * 16))
  }

  ensure (k) { if (this.n + k > this.cap) this.alloc(Math.max(this.cap * 2, this.n + k)) }

  v (x, y, z, r, g, b, a) {
    const i = this.n++
    this.f[i * 4] = x
    this.f[i * 4 + 1] = y
    this.f[i * 4 + 2] = z
    const o = i * 16 + 12
    this.u[o] = r
    this.u[o + 1] = g
    this.u[o + 2] = b
    this.u[o + 3] = a
  }

  take () {
    const out = this.u.slice(0, this.n * 16)
    this.n = 0
    return out
  }
}

const clamp255 = (v) => (v > 255 ? 255 : v < 0 ? 0 : v | 0)

// ------------------------------------------------------------------ world
export class World {
  constructor () {
    this.sections = new Map()
    this.kind = new Uint8Array(65536)
    this.opaque = new Uint8Array(65536)
    this.rgba = new Uint8Array(65536 * 4)
    this.top = new Uint8Array(65536 * 3)
    this.hasTop = new Uint8Array(65536)
    this.boxes = []
    this.names = []
    this.pad = new Uint16Array(P * P * P)
    this.opaqueBuf = new VertexBuffer()
    this.transBuf = new VertexBuffer(1 << 12)
    this.minY = 0
    this.height = 256
  }

  clear () {
    const old = [...this.sections.values()]
    this.sections.clear()
    return old
  }

  setPalette (entries) {
    for (const e of entries) {
      const i = e.i
      this.kind[i] = e.kind
      this.opaque[i] = e.kind === KIND.SOLID ? 1 : 0
      this.rgba.set([e.color[0], e.color[1], e.color[2], Math.round((e.alpha ?? 1) * 255)], i * 4)
      if (e.top) { this.top.set(e.top, i * 3); this.hasTop[i] = 1 }
      if (e.box) this.boxes[i] = e.box
      this.names[i] = e.name
    }
  }

  /** stores a section from the main process; returns the sections whose mesh must be rebuilt */
  put ({ cx, cy, cz, data }) {
    const key = sectionKey(cx, cy, cz)
    let s = this.sections.get(key)
    if (!s) {
      s = { key, cx, cy, cz, data: null, opaque: null, trans: null, dirty: true }
      this.sections.set(key, s)
    }
    s.data = data
    s.dirty = true
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = this.sections.get(sectionKey(cx + dx, cy + dy, cz + dz))
          if (n) n.dirty = true
        }
      }
    }
  }

  block (x, y, z) {
    const cx = Math.floor(x / 16)
    const cy = Math.floor(y / 16)
    const cz = Math.floor(z / 16)
    const s = this.sections.get(sectionKey(cx, cy, cz))
    if (!s || !s.data) return 0
    return s.data[((y - cy * 16) * 16 + (z - cz * 16)) * 16 + (x - cx * 16)]
  }

  fillPad (s) {
    const pad = this.pad
    for (let dy = -1; dy <= 1; dy++) {
      const y0 = dy < 0 ? 0 : dy > 0 ? 17 : 1
      const y1 = dy < 0 ? 0 : dy > 0 ? 17 : 16
      for (let dz = -1; dz <= 1; dz++) {
        const z0 = dz < 0 ? 0 : dz > 0 ? 17 : 1
        const z1 = dz < 0 ? 0 : dz > 0 ? 17 : 16
        for (let dx = -1; dx <= 1; dx++) {
          const x0 = dx < 0 ? 0 : dx > 0 ? 17 : 1
          const x1 = dx < 0 ? 0 : dx > 0 ? 17 : 16
          const n = this.sections.get(sectionKey(s.cx + dx, s.cy + dy, s.cz + dz))
          const data = n ? n.data : null
          for (let py = y0; py <= y1; py++) {
            const ly = py - 1 - dy * 16
            for (let pz = z0; pz <= z1; pz++) {
              const lz = pz - 1 - dz * 16
              let o = (py * P + pz) * P + x0
              let i = (ly * 16 + lz) * 16 + (x0 - 1 - dx * 16)
              for (let px = x0; px <= x1; px++) pad[o++] = data ? data[i++] : 0
            }
          }
        }
      }
    }
  }

  /** builds the vertex data for one section: { opaque, trans } (Uint8Array or null each) */
  mesh (s) {
    if (!s.data) return { opaque: null, trans: null }
    this.fillPad(s)
    const pad = this.pad
    const kind = this.kind
    const opq = this.opaque
    const rgba = this.rgba
    const ob = this.opaqueBuf
    const tb = this.transBuf
    const bx = s.cx * 16
    const by = s.cy * 16
    const bz = s.cz * 16
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const i = ((y + 1) * P + (z + 1)) * P + (x + 1)
          const id = pad[i]
          if (!id) continue
          const k = kind[id]
          if (!k) continue
          // a little brightness noise per block stands in for texture
          let hsh = ((bx + x) * 73856093) ^ ((by + y) * 19349663) ^ ((bz + z) * 83492791)
          hsh = (hsh ^ (hsh >>> 13)) * 1274126177
          const noise = 1 + (((hsh >>> 24) & 255) / 255 - 0.5) * 0.09
          const r = rgba[id * 4] * noise
          const g = rgba[id * 4 + 1] * noise
          const b = rgba[id * 4 + 2] * noise
          const a = rgba[id * 4 + 3]
          if (k === KIND.SOLID) {
            for (let f = 0; f < 6; f++) {
              const face = FACES[f]
              if (opq[pad[i + face.nd]]) continue
              let fr = r
              let fg = g
              let fb = b
              if (f === 0 && this.hasTop[id]) {
                fr = this.top[id * 3] * noise
                fg = this.top[id * 3 + 1] * noise
                fb = this.top[id * 3 + 2] * noise
              }
              this.quadAO(ob, face, i, x, y, z, fr, fg, fb)
            }
          } else if (k === KIND.GLASS) {
            for (let f = 0; f < 6; f++) {
              const n = pad[i + FACES[f].nd]
              if (opq[n] || n === id) continue
              this.box(tb, x, y, z, 0, 0, 0, 1, 1, 1, f, r, g, b, a)
            }
          } else if (k === KIND.LIQUID) {
            const above = pad[i + FACES[0].nd]
            const h = kind[above] === KIND.LIQUID ? 1 : 0.875
            const buf = a < 255 ? tb : ob
            for (let f = 0; f < 6; f++) {
              const n = pad[i + FACES[f].nd]
              if (opq[n] || kind[n] === KIND.LIQUID) continue
              this.box(buf, x, y, z, 0, 0, 0, 1, h, 1, f, r, g, b, a)
            }
          } else if (k === KIND.SLAB || k === KIND.THIN) {
            const h = k === KIND.SLAB ? 0.5 : 0.0625
            for (let f = 0; f < 6; f++) {
              if (f !== 0 && opq[pad[i + FACES[f].nd]]) continue
              this.box(ob, x, y, z, 0, 0, 0, 1, h, 1, f, r, g, b, a)
            }
          } else if (k === KIND.POST) {
            const buf = a < 255 ? tb : ob
            for (let f = 0; f < 6; f++) {
              if (f < 2 && opq[pad[i + FACES[f].nd]]) continue
              this.box(buf, x, y, z, 0.375, 0, 0.375, 0.625, 1, 0.625, f, r, g, b, a)
            }
          } else if (k === KIND.BOX) {
            const bb = this.boxes[id] || [0, 0, 0, 1, 1, 1]
            const buf = a < 255 ? tb : ob
            for (let f = 0; f < 6; f++) {
              // a face flush with the block's side is hidden by a solid neighbour
              const flush = f === 0 ? bb[4] === 1 : f === 1 ? bb[1] === 0 : f === 2 ? bb[3] === 1 : f === 3 ? bb[0] === 0 : f === 4 ? bb[5] === 1 : bb[2] === 0
              if (flush && opq[pad[i + FACES[f].nd]]) continue
              this.box(buf, x, y, z, bb[0], bb[1], bb[2], bb[3], bb[4], bb[5], f, r, g, b, a)
            }
          } else if (k === KIND.PLANT) {
            this.cross(ob, x, y, z, r, g, b, hsh)
          }
        }
      }
    }
    return { opaque: ob.n ? ob.take() : null, trans: tb.n ? tb.take() : null }
  }

  quadAO (buf, face, i, x, y, z, r, g, b) {
    const pad = this.pad
    const opq = this.opaque
    const lv = [0, 0, 0, 0]
    for (let c = 0; c < 4; c++) {
      const ao = face.ao[c]
      const s1 = opq[pad[i + ao[0]]]
      const s2 = opq[pad[i + ao[1]]]
      const cc = opq[pad[i + ao[2]]]
      lv[c] = s1 && s2 ? 0 : 3 - (s1 + s2 + cc)
    }
    const order = lv[0] + lv[2] < lv[1] + lv[3] ? [0, 1, 3, 1, 2, 3] : [0, 1, 2, 0, 2, 3]
    buf.ensure(6)
    for (const c of order) {
      const p = face.corners[c]
      const m = face.shade * AO[lv[c]]
      buf.v(x + p[0], y + p[1], z + p[2], clamp255(r * m), clamp255(g * m), clamp255(b * m), 255)
    }
  }

  // one face (f) of an axis-aligned box inside block x y z
  box (buf, x, y, z, x0, y0, z0, x1, y1, z1, f, r, g, b, a) {
    const face = FACES[f]
    const m = face.shade
    const cr = clamp255(r * m)
    const cg = clamp255(g * m)
    const cb = clamp255(b * m)
    buf.ensure(6)
    for (const c of [0, 1, 2, 0, 2, 3]) {
      const p = face.corners[c]
      buf.v(x + (p[0] ? x1 : x0), y + (p[1] ? y1 : y0), z + (p[2] ? z1 : z0), cr, cg, cb, a)
    }
  }

  // flowers, grass, saplings...: two crossed quads, a little smaller than a block
  cross (buf, x, y, z, r, g, b, hsh) {
    const lo = 0.22
    const hi = 0.78
    const top = 0.62 + ((hsh >>> 8) & 15) / 100
    const quads = [[lo, lo, hi, hi], [hi, lo, lo, hi]]
    buf.ensure(12)
    for (const [ax, az, bx, bz] of quads) {
      const v = [[ax, 0, az, 0.55], [bx, 0, bz, 0.55], [bx, top, bz, 0.95], [ax, top, az, 0.95]]
      for (const c of [0, 1, 2, 0, 2, 3]) {
        const p = v[c]
        buf.v(x + p[0], y + p[1], z + p[2], clamp255(r * p[3]), clamp255(g * p[3]), clamp255(b * p[3]), 255)
      }
    }
  }

  /** the block under the crosshair: { x, y, z, id, box: [x0,y0,z0,x1,y1,z1], dist } or null */
  raycast (ox, oy, oz, d, maxDist) {
    let x = Math.floor(ox)
    let y = Math.floor(oy)
    let z = Math.floor(oz)
    const sx = Math.sign(d[0])
    const sy = Math.sign(d[1])
    const sz = Math.sign(d[2])
    const tdx = sx ? Math.abs(1 / d[0]) : Infinity
    const tdy = sy ? Math.abs(1 / d[1]) : Infinity
    const tdz = sz ? Math.abs(1 / d[2]) : Infinity
    let tx = sx > 0 ? (x + 1 - ox) * tdx : sx < 0 ? (ox - x) * tdx : Infinity
    let ty = sy > 0 ? (y + 1 - oy) * tdy : sy < 0 ? (oy - y) * tdy : Infinity
    let tz = sz > 0 ? (z + 1 - oz) * tdz : sz < 0 ? (oz - z) * tdz : Infinity
    let t = 0
    for (let n = 0; n < 64 && t <= maxDist; n++) {
      const id = this.block(x, y, z)
      const k = id ? this.kind[id] : 0
      if (k && k !== KIND.LIQUID) {
        const box = k === KIND.SLAB ? [0, 0, 0, 1, 0.5, 1] : k === KIND.THIN ? [0, 0, 0, 1, 0.0625, 1] : k === KIND.POST ? [0.375, 0, 0.375, 0.625, 1, 0.625] : k === KIND.PLANT ? [0.22, 0, 0.22, 0.78, 0.7, 0.78] : k === KIND.BOX ? (this.boxes[id] || [0, 0, 0, 1, 1, 1]) : [0, 0, 0, 1, 1, 1]
        return { x, y, z, id, name: this.names[id] || '', box, dist: t }
      }
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx } else if (ty < tz) { y += sy; t = ty; ty += tdy } else { z += sz; t = tz; tz += tdz }
    }
    return null
  }
}

// ------------------------------------------------------------------ GL
const VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_color;
uniform mat4 u_viewProj;
uniform vec3 u_offset;
out vec4 v_color;
out float v_dist;
void main() {
  vec3 p = a_pos + u_offset;
  v_color = a_color;
  v_dist = length(p);
  gl_Position = u_viewProj * vec4(p, 1.0);
}`

const FS = `#version 300 es
precision mediump float;
in vec4 v_color;
in float v_dist;
uniform vec3 u_fogColor;
uniform vec2 u_fog;
uniform float u_light;
out vec4 o_color;
void main() {
  float f = clamp((v_dist - u_fog.x) / (u_fog.y - u_fog.x), 0.0, 1.0);
  o_color = vec4(mix(v_color.rgb * u_light, u_fogColor, f), v_color.a);
}`

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor (canvas) {
    this.canvas = canvas
    this.world = new World()
    this.ok = false
    this.lost = false
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.ok = false })
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.init(); for (const s of this.world.sections.values()) { s.opaque = s.trans = null; s.dirty = true } })
    this.init()
  }

  init () {
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.gl = gl
    if (!gl) return
    const compile = (type, src) => {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh))
      return sh
    }
    const prog = gl.createProgram()
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
    this.prog = prog
    this.u = {}
    for (const n of ['u_viewProj', 'u_offset', 'u_fogColor', 'u_fog', 'u_light']) this.u[n] = gl.getUniformLocation(prog, n)
    this.dyn = this.makeMesh(null) // entities and the block outline, rebuilt every frame
    this.dynBuf = new VertexBuffer(1 << 12)
    this.ok = true
  }

  makeMesh (bytes) {
    const gl = this.gl
    const vao = gl.createVertexArray()
    const vbo = gl.createBuffer()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    if (bytes) gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 16, 12)
    gl.bindVertexArray(null)
    return { vao, vbo, count: bytes ? bytes.length / 16 : 0 }
  }

  freeMesh (m) {
    if (!m || !this.gl || this.lost) return
    this.gl.deleteBuffer(m.vbo)
    this.gl.deleteVertexArray(m.vao)
  }

  freeSection (s) {
    this.freeMesh(s.opaque)
    this.freeMesh(s.trans)
    s.opaque = s.trans = null
  }

  reset (minY, height) {
    for (const s of this.world.clear()) this.freeSection(s)
    this.world.minY = minY
    this.world.height = height
  }

  drop (keys) {
    for (const k of keys) {
      const s = this.world.sections.get(k)
      if (!s) continue
      this.freeSection(s)
      this.world.sections.delete(k)
    }
  }

  // rebuild dirty sections, nearest first, within a time budget
  remesh (cam, budgetMs) {
    if (!this.ok) return 0
    const start = performance.now()
    const ccx = Math.floor(cam[0] / 16)
    const ccy = Math.floor(cam[1] / 16)
    const ccz = Math.floor(cam[2] / 16)
    const dirty = []
    for (const s of this.world.sections.values()) if (s.dirty) dirty.push(s)
    if (!dirty.length) return 0
    dirty.sort((a, b) => ((a.cx - ccx) ** 2 + (a.cy - ccy) ** 2 + (a.cz - ccz) ** 2) - ((b.cx - ccx) ** 2 + (b.cy - ccy) ** 2 + (b.cz - ccz) ** 2))
    let done = 0
    for (const s of dirty) {
      const m = this.world.mesh(s)
      this.freeSection(s)
      s.opaque = m.opaque ? this.makeMesh(m.opaque) : null
      s.trans = m.trans ? this.makeMesh(m.trans) : null
      s.dirty = false
      done++
      if (performance.now() - start > budgetMs) break
    }
    return dirty.length - done
  }

  resize () {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  /**
   * @param {object} view { eye: [x,y,z], yaw, pitch, sky: [r,g,b], light, far, entities: [...], target }
   */
  draw (view) {
    if (!this.ok) return
    const gl = this.gl
    this.resize()
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const sky = view.sky
    gl.clearColor(sky[0], sky[1], sky[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.useProgram(this.prog)

    const pitch = Math.max(-1.5697, Math.min(1.5697, view.pitch))
    const dir = direction(view.yaw, pitch)
    const proj = perspective(70 * Math.PI / 180, this.canvas.width / this.canvas.height, 0.05, view.far + 32)
    this.vp = multiply(proj, lookDir(dir))
    gl.uniformMatrix4fv(this.u.u_viewProj, false, this.vp)
    gl.uniform3f(this.u.u_fogColor, sky[0], sky[1], sky[2])
    gl.uniform2f(this.u.u_fog, view.far * 0.55, view.far)
    gl.uniform1f(this.u.u_light, view.light)

    const [ex, ey, ez] = view.eye
    const visible = []
    for (const s of this.world.sections.values()) {
      if (!s.opaque && !s.trans) continue
      const rx = s.cx * 16 + 8 - ex
      const ry = s.cy * 16 + 8 - ey
      const rz = s.cz * 16 + 8 - ez
      const along = rx * dir[0] + ry * dir[1] + rz * dir[2]
      if (along < -14) continue // behind the camera
      const d2 = rx * rx + ry * ry + rz * rz
      if (d2 > (view.far + 14) ** 2) continue
      visible.push([d2, s])
    }
    gl.disable(gl.BLEND)
    gl.depthMask(true)
    for (const [, s] of visible) {
      if (!s.opaque) continue
      gl.uniform3f(this.u.u_offset, s.cx * 16 - ex, s.cy * 16 - ey, s.cz * 16 - ez)
      gl.bindVertexArray(s.opaque.vao)
      gl.drawArrays(gl.TRIANGLES, 0, s.opaque.count)
    }

    // entities and the outline of the block under the crosshair
    const dyn = this.dynBuf
    for (const e of view.entities) this.entityBoxes(dyn, e, ex, ey, ez)
    const lineStart = dyn.n
    if (view.target) this.outline(dyn, view.target, ex, ey, ez)
    const lineCount = dyn.n - lineStart
    if (dyn.n) {
      const bytes = dyn.take()
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dyn.vbo)
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW)
      gl.uniform3f(this.u.u_offset, 0, 0, 0)
      gl.bindVertexArray(this.dyn.vao)
      if (lineStart) gl.drawArrays(gl.TRIANGLES, 0, lineStart)
      if (lineCount) gl.drawArrays(gl.LINES, lineStart, lineCount)
    }

    // see-through blocks last, far to near
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false)
    visible.sort((a, b) => b[0] - a[0])
    for (const [, s] of visible) {
      if (!s.trans) continue
      gl.uniform3f(this.u.u_offset, s.cx * 16 - ex, s.cy * 16 - ey, s.cz * 16 - ez)
      gl.bindVertexArray(s.trans.vao)
      gl.drawArrays(gl.TRIANGLES, 0, s.trans.count)
    }
    gl.depthMask(true)
    gl.bindVertexArray(null)
  }

  // a box from x0,y0,z0 to x1,y1,z1 (camera-relative), all six faces
  cube (buf, x0, y0, z0, x1, y1, z1, rgb, topRgb) {
    buf.ensure(36)
    for (let f = 0; f < 6; f++) {
      const face = FACES[f]
      const c = f === 0 && topRgb ? topRgb : rgb
      const m = face.shade
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const p = face.corners[k]
        buf.v(p[0] ? x1 : x0, p[1] ? y1 : y0, p[2] ? z1 : z0, clamp255(c[0] * m), clamp255(c[1] * m), clamp255(c[2] * m), 255)
      }
    }
  }

  // a box turned to face yaw: centre cx/cz, half length (forward) hl, half width hw
  turnedBox (buf, cx, cz, yaw, fwd, side, hl, hw, y0, y1, rgb) {
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    const rx = Math.cos(yaw)
    const rz = -Math.sin(yaw)
    const ox = cx + fx * fwd + rx * side
    const oz = cz + fz * fwd + rz * side
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [ox + fx * hl * a + rx * hw * b, oz + fz * hl * a + rz * hw * b])
    const quad = (p, shade) => {
      const col = [clamp255(rgb[0] * shade), clamp255(rgb[1] * shade), clamp255(rgb[2] * shade)]
      for (const k of [0, 1, 2, 0, 2, 3]) buf.v(p[k][0], p[k][1], p[k][2], col[0], col[1], col[2], 255)
    }
    buf.ensure(36)
    quad(c.map(([x, z]) => [x, y1, z]), 1)
    quad(c.map(([x, z]) => [x, y0, z]), 0.5)
    for (let i = 0; i < 4; i++) {
      const a = c[i]
      const b = c[(i + 1) % 4]
      quad([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], i % 2 ? 0.8 : 0.64)
    }
  }

  entityBoxes (buf, e, ex, ey, ez) {
    if (e.invisible) return
    const x = e.x - ex
    const y = e.y - ey
    const z = e.z - ez
    const w = e.w / 2
    const look = MOBS[e.type]
    if (e.kind === 'player' || (look && look.model === 'humanoid')) {
      const hue = hashName(e.name) % 360
      const body = look ? look.body : hsl(hue, 0.45, 0.42)
      const legs = look ? look.legs : hsl(hue, 0.35, 0.25)
      const skin = look ? look.skin : [214, 172, 140]
      const s = e.h / 1.8 // sneaking players, endermen, children...
      const hw = Math.min(0.5, Math.max(0.2, w * 0.85))
      this.turnedBox(buf, x, z, e.yaw, 0, 0, 0.13, hw, y, y + 0.72 * s, legs)
      this.turnedBox(buf, x, z, e.yaw, 0, 0, 0.14, hw, y + 0.72 * s, y + 1.38 * s, body)
      this.turnedBox(buf, x, z, e.yaw, 0, -hw - 0.12, 0.12, 0.12, y + 0.7 * s, y + 1.38 * s, skin)
      this.turnedBox(buf, x, z, e.yaw, 0, hw + 0.12, 0.12, 0.12, y + 0.7 * s, y + 1.38 * s, skin)
      this.turnedBox(buf, x, z, e.yaw, 0, 0, 0.24, 0.24, y + 1.38 * s, y + 1.38 * s + 0.48 * Math.max(0.6, s), look ? look.head || skin : skin)
    } else if (look && look.model === 'quad') {
      const hl = Math.max(0.3, w * 1.15)
      const hw = Math.max(0.18, w * 0.62)
      const legH = e.h * (look.legs ?? 0.38)
      const top = e.h * 0.82
      const headS = Math.min(0.32, hw * 0.85)
      for (const [f, sd] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) this.turnedBox(buf, x, z, e.yaw, f * (hl - 0.12), sd * (hw - 0.1), 0.08, 0.08, y, y + legH, look.leg || look.body.map(v => v * 0.8))
      this.turnedBox(buf, x, z, e.yaw, 0, 0, hl, hw, y + legH, y + top, look.body)
      this.turnedBox(buf, x, z, e.yaw, hl + headS * 0.7, 0, headS, headS * 0.9, y + top - headS * 0.6, y + top + headS * 1.3, look.head || look.body)
    } else if (e.kind === 'item') {
      const bob = Math.sin(performance.now() / 400 + e.id) * 0.06 + 0.2
      this.cube(buf, x - 0.13, y + bob, z - 0.13, x + 0.13, y + bob + 0.26, z + 0.13, e.color || [235, 200, 70])
    } else {
      const c = look ? look.body : e.kind === 'hostile' ? hsl(hashName(e.name) % 40, 0.55, 0.4) : e.kind === 'mob' ? hsl(hashName(e.name) % 360, 0.28, 0.5) : [150, 150, 158]
      this.turnedBox(buf, x, z, e.yaw, 0, 0, Math.max(0.1, w), Math.max(0.1, w), y, y + e.h, c)
    }
  }

  outline (buf, t, ex, ey, ez) {
    const e = 0.003
    const [a0, b0, c0, a1, b1, c1] = t.box
    const x0 = t.x + a0 - e - ex
    const y0 = t.y + b0 - e - ey
    const z0 = t.z + c0 - e - ez
    const x1 = t.x + a1 + e - ex
    const y1 = t.y + b1 + e - ey
    const z1 = t.z + c1 + e - ez
    const pts = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
    buf.ensure(edges.length)
    for (const i of edges) buf.v(pts[i][0], pts[i][1], pts[i][2], 10, 10, 10, 255)
  }

  /** screen position (CSS pixels) of a world point as seen in the last frame, or null when behind the camera */
  project (view, x, y, z) {
    const m = this.vp
    if (!m) return null
    const rx = x - view.eye[0]
    const ry = y - view.eye[1]
    const rz = z - view.eye[2]
    const cx = m[0] * rx + m[4] * ry + m[8] * rz + m[12]
    const cy = m[1] * rx + m[5] * ry + m[9] * rz + m[13]
    const cw = m[3] * rx + m[7] * ry + m[11] * rz + m[15]
    if (cw <= 0.1) return null
    return { x: (cx / cw * 0.5 + 0.5) * this.canvas.clientWidth, y: (0.5 - cy / cw * 0.5) * this.canvas.clientHeight, dist: Math.hypot(rx, ry, rz) }
  }
}

/** sky colour and light level for a dimension and time of day (0-24000, 0 = sunrise) */
export function skyFor (dimension, timeOfDay) {
  if (/nether/.test(dimension)) return { sky: [0.22, 0.05, 0.04], light: 0.9 }
  if (/end/.test(dimension)) return { sky: [0.07, 0.05, 0.11], light: 0.8 }
  const sun = Number.isFinite(timeOfDay) ? Math.sin((timeOfDay / 24000) * PI2) : 1
  const light = Math.max(0.32, Math.min(1, 0.62 + sun * 0.75))
  const day = [0.56, 0.73, 0.96]
  const night = [0.03, 0.04, 0.09]
  const t = Math.max(0, Math.min(1, (sun + 0.25) / 0.6))
  return { sky: day.map((d, i) => night[i] + (d - night[i]) * t), light }
}
