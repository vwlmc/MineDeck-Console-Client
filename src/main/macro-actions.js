'use strict'
// What macro steps do with an account's connection (a mineflayer bot).
// Every function here works on one bot and only through mineflayer's normal
// player actions: the same packets a game client sends.
const { Vec3 } = require('vec3')
const { matchPattern } = require('./wildcard')
const { itemInfo, textSegments } = require('./pov')
const { plainText } = require('./chat-format')

/** an expected problem ("no food in the inventory"): reported, then the macro carries on */
class StepError extends Error {}

const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }
const rad = (deg) => deg * Math.PI / 180
const BAD_FOOD = /rotten_flesh|spider_eye|poisonous_potato|pufferfish|chorus_fruit|suspicious_stew/

function itemTexts (item, lang) {
  const info = itemInfo(item, lang)
  return {
    names: [plainText(info.label), item.displayName || '', String(item.name || '').replace(/_/g, ' ')],
    lore: (info.lore || []).map(plainText).join(' ')
  }
}

/** does an item match a name pattern ("sword", "Confirm", "*apple")? Empty matches anything. */
function itemMatches (pattern, item, lang, withLore = false) {
  if (!item) return false
  if (!String(pattern || '').trim()) return true
  const { names, lore } = itemTexts(item, lang)
  return names.some(n => n && matchPattern(pattern, n)) || (withLore && !!lore && !!matchPattern(pattern, lore))
}

function countItems (bot, pattern, lang) {
  return bot.inventory.items().filter(i => itemMatches(pattern, i, lang)).reduce((n, i) => n + i.count, 0)
}

function windowTitle (w, lang) {
  try { return plainText(textSegments(w.title, lang)) } catch { return '' }
}

function entityName (e, lang) {
  const names = [e.username, e.displayName, e.name]
  try { if (e.metadata && e.metadata[2]) names.push(plainText(textSegments(e.metadata[2], lang))) } catch { }
  return names.filter(Boolean)
}

const MOB_TYPES = new Set(['hostile', 'mob', 'animal', 'passive', 'water_creature', 'ambient', 'living'])
function nearest (bot, kind, name, range, lang) {
  const me = bot.entity
  return bot.nearestEntity(e => {
    if (e === me || !e.position || !e.isValid || e.position.distanceTo(me.position) > range) return false
    const type = String(e.type || '')
    if (kind === 'player') return type === 'player'
    if (kind === 'hostile') return type === 'hostile' || e.kind === 'Hostile mobs'
    if (kind === 'mob') return type !== 'player' && (MOB_TYPES.has(type) || /mobs$/i.test(String(e.kind || '')))
    if (kind === 'name') return entityName(e, lang).some(n => matchPattern(name, n))
    return false
  })
}

const aimAt = (bot, e) => bot.lookAt(e.position.offset(0, (Number(e.height) || 1.6) * 0.85, 0), true)

// ------------------------------------------------------------------ steps
async function clickMenu (bot, step, ctx) {
  const deadline = Date.now() + step.wait * 1000
  for (;;) {
    const w = bot.currentWindow
    if (w) {
      let slot = null
      if (step.slot !== null && step.slot < w.slots.length) slot = step.slot
      else if (step.match.trim()) {
        // the menu's own items first, then the player's inventory part
        const split = Number.isInteger(w.inventoryStart) ? w.inventoryStart : w.slots.length
        const order = [...Array(w.slots.length).keys()].sort((a, b) => (a < split ? 0 : 1) - (b < split ? 0 : 1) || a - b)
        slot = order.find(i => itemMatches(ctx.fill(step.match), w.slots[i], ctx.lang, true)) ?? null
      }
      if (slot !== null) {
        const click = Promise.resolve(bot.clickWindow(slot, step.button === 'right' ? 1 : 0, step.shift ? 1 : 0)).catch(() => {})
        await Promise.race([click, ctx.sleep(1500)])
        return `clicked slot ${slot}`
      }
    }
    if (Date.now() >= deadline) throw new StepError(w ? `no "${ctx.fill(step.match)}" in the menu` : 'no menu opened')
    await ctx.sleep(100)
  }
}

async function waitMenu (bot, step, ctx) {
  const deadline = Date.now() + step.timeout * 1000
  const pattern = ctx.fill(step.match)
  for (;;) {
    const w = bot.currentWindow
    if (w && (!pattern.trim() || matchPattern(pattern, windowTitle(w, ctx.lang)))) return true
    if (Date.now() >= deadline) return false
    await ctx.sleep(100)
  }
}

async function use (bot, step, ctx) {
  if (step.hold > 0) {
    bot.activateItem()
    try { await ctx.sleep(step.hold * 1000) } finally { if (bot.usingHeldItem) bot.deactivateItem() }
    return 'held'
  }
  const entity = bot.entityAtCursor(4)
  if (entity) { await Promise.resolve(bot.activateEntity(entity)).catch(() => {}); return 'entity' }
  const block = bot.blockAtCursor(5)
  if (block) { await Promise.resolve(bot.activateBlock(block)).catch(() => {}); return 'block' }
  bot.activateItem()
  await ctx.sleep(100)
  if (bot.usingHeldItem) bot.deactivateItem()
  return 'item'
}

async function attack (bot, step, ctx) {
  if (step.target === 'crosshair') {
    const e = bot.entityAtCursor(step.range)
    if (e) { bot.attack(e); return 'hit' }
    bot.swingArm()
    return 'swing'
  }
  const e = nearest(bot, step.target, ctx.fill(step.name), step.range, ctx.lang)
  if (!e) return 'nothing in range'
  await aimAt(bot, e)
  bot.attack(e)
  return 'hit'
}

async function equip (bot, pattern, ctx) {
  pattern = ctx.fill(pattern)
  if (bot.heldItem && itemMatches(pattern, bot.heldItem, ctx.lang)) return 'already held'
  const item = bot.inventory.items().find(i => itemMatches(pattern, i, ctx.lang))
  if (!item) throw new StepError(`no "${pattern}" in the inventory`)
  await bot.equip(item, 'hand')
  return 'equipped'
}

async function eat (bot, step) {
  if (bot.food >= step.below) return 'not hungry'
  const foods = bot.registry.foodsByName || {}
  const options = bot.inventory.items().filter(i => foods[i.name] && !BAD_FOOD.test(i.name))
  if (!options.length) throw new StepError('no food in the inventory')
  options.sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))
  const before = bot.quickBarSlot
  await bot.equip(options[0], 'hand')
  try {
    await bot.consume()
  } catch (e) {
    if (!/full/i.test(e.message)) throw new StepError(`couldn't eat (${e.message})`)
  }
  if (bot.quickBarSlot !== before) bot.setQuickBarSlot(before)
  return 'ate'
}

async function drop (bot, step, ctx) {
  const pattern = ctx.fill(step.item)
  if (!pattern.trim()) {
    if (!bot.heldItem) throw new StepError('nothing in hand to drop')
    await bot.tossStack(bot.heldItem)
    return 'dropped'
  }
  const items = bot.inventory.items().filter(i => itemMatches(pattern, i, ctx.lang))
  if (!items.length) throw new StepError(`no "${pattern}" to drop`)
  for (const it of step.all ? items : items.slice(0, 1)) await bot.tossStack(it)
  return 'dropped'
}

async function fish (bot, step, ctx) {
  const isRod = (i) => i && i.name === 'fishing_rod'
  if (!isRod(bot.heldItem)) {
    const rod = bot.inventory.items().find(isRod)
    if (!rod) throw new StepError('no fishing rod')
    await bot.equip(rod, 'hand')
  }
  const caught = bot.fish().then(() => 'caught', () => 'lost the bobber')
  try {
    const result = await Promise.race([caught, ctx.sleep(step.timeout * 1000).then(() => 'timeout')])
    if (result === 'timeout') { bot.activateItem(); await ctx.sleep(300); return 'no bite, reeled in' }
    return result
  } catch (e) {
    try { bot.activateItem() } catch { } // stopped: reel the line in
    throw e
  }
}

async function look (bot, step, ctx) {
  if (step.mode === 'direction') return bot.look(YAW[step.dir], rad(step.pitch), true)
  if (step.mode === 'turn') return bot.look(bot.entity.yaw - rad(step.turn), bot.entity.pitch, true)
  if (step.mode === 'position') return bot.lookAt(new Vec3(step.x, step.y, step.z), true)
  const e = nearest(bot, step.target, '', 64, ctx.lang)
  if (!e) throw new StepError('nobody to look at')
  return aimAt(bot, e)
}

async function move (bot, step, ctx) {
  bot.setControlState(step.dir, true)
  if (step.sprint) bot.setControlState('sprint', true)
  if (step.jump) bot.setControlState('jump', true)
  try {
    await ctx.sleep(step.sec * 1000)
  } finally {
    bot.setControlState(step.dir, false)
    if (step.sprint) bot.setControlState('sprint', false)
    if (step.jump) bot.setControlState('jump', false)
  }
}

// straight-line walking (no path finding): jumps up single blocks on the way
async function goto (bot, step, ctx) {
  const tx = Number.isInteger(step.x) ? step.x + 0.5 : step.x
  const tz = Number.isInteger(step.z) ? step.z + 0.5 : step.z
  const deadline = Date.now() + step.timeout * 1000
  try {
    for (;;) {
      const p = bot.entity.position
      const dx = tx - p.x
      const dz = tz - p.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.5) return 'arrived'
      if (Date.now() > deadline) throw new StepError(`didn't reach ${step.x} ${step.z} in time (${dist.toFixed(1)} blocks away)`)
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', step.sprint && dist > 3)
      bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
      await ctx.sleep(dist < 2 ? 50 : 100)
    }
  } finally {
    for (const c of ['forward', 'sprint', 'jump']) bot.setControlState(c, false)
  }
}

async function control (bot, step, ctx) {
  switch (step.action) {
    case 'jump':
      bot.setControlState('jump', true)
      try { await ctx.sleep(300) } finally { bot.setControlState('jump', false) }
      break
    case 'sneakOn': bot.setControlState('sneak', true); break
    case 'sneakOff': bot.setControlState('sneak', false); break
    case 'sprintOn': bot.setControlState('sprint', true); break
    case 'sprintOff': bot.setControlState('sprint', false); break
  }
}

module.exports = {
  StepError,
  itemMatches,
  countItems,
  windowTitle,
  actions: { clickMenu, waitMenu, use, attack, equip, eat, drop, fish, look, move, goto, control }
}
