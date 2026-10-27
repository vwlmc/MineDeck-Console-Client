'use strict'
// A tiny Minecraft server for tests (offline mode unless asked otherwise). It speaks just enough of the
// protocol (via minecraft-protocol) for a client to join, chat, and be kicked.
const mc = require('minecraft-protocol')
const nbt = require('prismarine-nbt')

// A 3x3 chunk area around 0,0: stone from y 60 to 63, grass on top, and a glass block at 2,65,2.
// build(set, cx, cz) can replace that with any scene; radius sets how many chunks around 0,0.
function sendWorld (client, mcData, version, build = null, radius = 1) {
  const Chunk = require('prismarine-chunk')(version)
  const Vec3 = require('vec3')
  const types = mcData.protocol.play.toClient.types
  const fields = new Map(types.packet_map_chunk[1].map(f => [f.name, f.type]))
  const tall = mcData.supportFeature('tallWorld')
  const state = (name) => {
    const b = mcData.blocksByName[name]
    return mcData.supportFeature('blockStateId') ? b.defaultState : b.id << 4
  }
  const stone = state('stone')
  const grass = state(mcData.blocksByName.grass_block ? 'grass_block' : 'grass')
  const glass = state('glass')
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      const chunk = tall ? new Chunk({ minY: -64, worldHeight: 384 }) : new Chunk()
      const pos = new Vec3(0, 0, 0)
      if (build) {
        build((x, y, z, name) => chunk.setBlockStateId(new Vec3(x - cx * 16, y, z - cz * 16), state(name)), cx, cz)
      } else {
        for (let x = 0; x < 16; x++) {
          for (let z = 0; z < 16; z++) {
            pos.x = x; pos.z = z
            for (let y = 60; y <= 64; y++) { pos.y = y; chunk.setBlockStateId(pos, y === 64 ? grass : stone) }
            if (chunk.setSkyLight) for (let y = 65; y < 80; y++) { pos.y = y; try { chunk.setSkyLight(pos, 15) } catch { } }
          }
        }
        if (cx === 0 && cz === 0) chunk.setBlockStateId(new Vec3(2, 65, 2), glass)
      }
      const lights = chunk.dumpLight ? chunk.dumpLight() : {}
      const packet = { x: cx, z: cz, groundUp: true, bitMap: chunk.getMask(), chunkData: chunk.dump(), blockEntities: [], trustEdges: false }
      if (fields.has('biomes') && chunk.dumpBiomes) packet.biomes = chunk.dumpBiomes()
      if (fields.has('heightmaps')) {
        packet.heightmaps = Array.isArray(fields.get('heightmaps')) && fields.get('heightmaps')[0] === 'array'
          ? []
          : { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(tall ? 37 : 36).fill([0, 0]) } } }
      }
      for (const k of ['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask', 'skyLight', 'blockLight']) {
        if (fields.has(k)) packet[k] = lights[k] ?? []
      }
      client.write('map_chunk', packet)
    }
  }
}

// "!menu" opens a chest with a lime "Confirm" and a red "Cancel" item, like a plugin's confirmation screen
function openMenu (client, mcData, version) {
  const Item = require('prismarine-item')(version)
  const types = mcData.protocol.play.toClient.types
  const titleType = types.packet_open_window[1].find(f => f.name === 'windowTitle').type
  const title = titleType === 'string' ? JSON.stringify({ text: 'Confirm purchase?' }) : nbt.comp({ text: nbt.string('Confirm purchase?') })
  const legacyWindow = types.packet_open_window[1].some(f => f.name === 'slotCount')
  client.write('open_window', legacyWindow
    ? { windowId: 7, inventoryType: 'minecraft:chest', windowTitle: title, slotCount: 27 }
    : { windowId: 7, inventoryType: 2, windowTitle: title }) // 2 = generic_9x3
  const flat = !!mcData.itemsByName.lime_wool // 1.13+: one item per colour
  const named = (dye, meta, base, text, color, lore) => {
    const def = flat ? mcData.itemsByName[`${dye}_${base}`] : mcData.itemsByName[base === 'wool' ? 'wool' : 'stained_glass_pane']
    const item = new Item(def.id, 1, flat ? 0 : meta)
    if (!text) return item
    if (mcData.supportFeature('itemsWithComponents')) {
      const comp = (t, c) => nbt.comp({ text: nbt.string(t), color: nbt.string(c), italic: nbt.byte(0) })
      item.components = [{ type: 'custom_name', data: comp(text, color) }, { type: 'lore', data: lore.map(l => comp(l, 'gray')) }]
    } else {
      const legacy = !mcData.supportFeature('blockStateId')
      const fmt = (t, c) => legacy ? `\u00a7${c === 'green' ? 'a' : c === 'red' ? 'c' : '7'}${t}` : JSON.stringify({ text: t, color: c, italic: false })
      item.nbt = nbt.comp({ display: nbt.comp({ Name: nbt.string(fmt(text, color)), Lore: nbt.list(nbt.string(lore.map(l => fmt(l, 'gray')))) }) })
    }
    return item
  }
  const filler = named('gray', 7, 'stained_glass_pane')
  const slots = Array.from({ length: 27 }, () => filler)
  slots[11] = named('lime', 5, 'wool', 'Confirm', 'green', ['Buy 64x Diamond', 'for $1,250'])
  slots[13] = named('lime', 5, 'wool', 'Confirm', 'green', ['Click to confirm'])
  slots[15] = named('red', 14, 'wool', 'Cancel', 'red', ['Keep your money'])
  // the player's own items fill the bottom part, like a real server sends them
  const own = Array.isArray(client.inventory) ? client.inventory.slice(9, 45) : Array(36).fill(null)
  const items = [...slots, ...own].map(i => Item.toNotch(i))
  const windowItems = types.packet_window_items[1].map(f => f.name)
  client.write('window_items', windowItems.includes('stateId')
    ? { windowId: 7, stateId: 1, items, carriedItem: Item.toNotch(null) }
    : { windowId: 7, items })
}

function startFakeServer ({ version, port = 0, motd = 'MineDeck test server', onChat, onJoin, online = false, echoCommands = true, resourcePack = false, world = false, build = null, radius = 1, spawn = null } = {}) {
  // online: true makes the server verify players with the session server
  // (tests stub sessionserver.mojang.com through globalThis.fetch)
  // world: true sends a small world around 0,0 and answers "!menu" with a chest menu
  const server = mc.createServer({ 'online-mode': online, version, port, host: '127.0.0.1', motd, 'max-players': 20 })
  const mcData = require('minecraft-data')(server.version)
  const received = []

  function component (text) {
    return mcData.supportFeature('chatPacketsUseNbtComponents')
      ? nbt.comp({ text: nbt.string(text) })
      : JSON.stringify({ text })
  }

  const playing = () => Object.values(server.clients).filter(c => c.state === 'play')

  function systemChat (client, text) {
    if (mcData.supportFeature('signedChat')) {
      const packet = { content: component(text) }
      // 1.19 used "type"/"position"; 1.19.1+ uses isActionBar
      packet.isActionBar = false
      packet.type = 1
      packet.position = 1
      client.write('system_chat', packet)
    } else {
      client.write('chat', { message: JSON.stringify({ text }), position: 0, sender: '00000000-0000-0000-0000-000000000000' })
    }
  }

  server.on('playerJoin', (client) => {
    client.write('login', {
      // 1.7 - 1.15 login fields (ignored by newer versions)
      dimension: 0,
      difficulty: 0,
      levelType: 'default',
      ...mcData.loginPacket,
      enforceSecureChat: false,
      entityId: client.id,
      isHardcore: false,
      gameMode: 0,
      previousGameMode: 1,
      hashedSeed: [0, 0],
      maxPlayers: 20,
      viewDistance: 2,
      reducedDebugInfo: false,
      enableRespawnScreen: true,
      isDebug: false,
      isFlat: true
    })
    if (world) sendWorld(client, mcData, server.version, build, radius)
    client.write('position', { x: 0.5, y: world ? 65 : 100, z: 0.5, yaw: 0, pitch: 0, flags: 0, teleportId: 1, dx: 0, dy: 0, dz: 0, ...spawn })
    if (onJoin) setTimeout(() => onJoin(client, mcData), 300)
    client.windowClicks = []
    client.moves = []
    client.on('window_click', (p) => { client.windowClicks.push(p); received.push({ username: client.username, windowClick: p }) })
    for (const name of ['position', 'position_look']) client.on(name, (p) => client.moves.push({ x: p.x, y: p.y, z: p.z }))
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    setTimeout(() => systemChat(client, `Welcome ${client.username}!`), 200)

    // offer a resource pack, like many servers do right after joining
    client.resourcePackAnswers = []
    client.on('resource_pack_receive', (p) => {
      client.resourcePackAnswers.push(p)
      received.push({ username: client.username, resourcePack: p })
    })
    if (resourcePack && (mcData.supportFeature('resourcePackUsesUUID') || server.version !== '1.7.10')) {
      setTimeout(() => {
        const pack = { url: 'https://example.com/pack.zip', hash: '0123456789abcdef0123456789abcdef01234567', forced: false, promptMessage: undefined }
        if (mcData.supportFeature('resourcePackUsesUUID')) client.write('add_resource_pack', { ...pack, uuid: '7a3b2f8e-1c4d-4e5f-9a6b-0c1d2e3f4a5b' })
        else client.write('resource_pack_send', pack)
      }, 100)
    }

    const handle = (data) => {
      const msg = data.message ?? data.command
      received.push({ username: client.username, message: msg })
      if (onChat) onChat(client, msg, { systemChat: (t) => systemChat(client, t), server })
      if (msg === '!menu' && world) { openMenu(client, mcData, server.version); return }
      if (msg === '!close' && world) { client.write('close_window', { windowId: 7 }); return }
      if (msg === '!kick') client.end('Kicked by test')
      else if (msg === '!ban') client.end('You are banned from this server!')
      else if (echoCommands || !msg.startsWith('/')) for (const c of playing()) systemChat(c, `<${client.username}> ${msg}`)
    }
    client.on('chat', handle)
    client.on('chat_message', handle)
    client.on('chat_command', (d) => handle({ message: '/' + d.command }))
    client.on('chat_command_signed', (d) => handle({ message: '/' + d.command }))
  })

  // a chat component (JSON form) to one player, as NBT on 1.20.3+
  const toNbt = (v) => {
    if (typeof v === 'string') return nbt.string(v)
    if (typeof v === 'boolean') return nbt.byte(v ? 1 : 0)
    if (typeof v === 'number') return nbt.int(v)
    if (Array.isArray(v)) return nbt.list(nbt.comp(v.map(x => toNbt(x).value)))
    return nbt.comp(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toNbt(x)])))
  }
  function componentChat (client, json) {
    if (mcData.supportFeature('signedChat')) {
      const content = mcData.supportFeature('chatPacketsUseNbtComponents') ? toNbt(json) : JSON.stringify(json)
      client.write('system_chat', { content, isActionBar: false, type: 1, position: 1 })
    } else {
      client.write('chat', { message: JSON.stringify(json), position: 0, sender: '00000000-0000-0000-0000-000000000000' })
    }
  }

  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve({
      server,
      port: server.socketServer.address().port,
      received,
      componentChat,
      broadcast: (t) => { for (const c of playing()) systemChat(c, t) },
      kickAll: (reason) => { for (const c of Object.values(server.clients)) c.end(reason) },
      close: () => new Promise(r => { server.close(); setTimeout(r, 50) })
    }))
    server.once('error', reject)
  })
}

module.exports = { startFakeServer }
