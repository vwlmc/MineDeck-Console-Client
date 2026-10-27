'use strict'
// Colours and shapes for the POV view. MineDeck draws blocks and items as
// coloured shapes instead of shipping Minecraft's textures (which belong to
// Mojang), so each block gets an approximate colour from its name.

// shape kinds understood by the POV renderer
//   SOLID full cube · GLASS full see-through cube · LIQUID water/lava · SLAB half block
//   THIN flat layer (carpet, rails, pressure plates...) · PLANT crossed sprites · POST fences, walls, panes
//   BOX a smaller box (chests, beds, lanterns, torches...), given as `box`
const KIND = { AIR: 0, SOLID: 1, GLASS: 2, LIQUID: 3, SLAB: 4, THIN: 5, PLANT: 6, POST: 7, BOX: 8 }

// blocks drawn as a smaller box: [pattern, [x0, y0, z0, x1, y1, z1]] in 16ths of a block
const BOXES = [
  [/^(chest|trapped_chest|ender_chest)$/, [1, 0, 1, 15, 14, 15]],
  [/_bed$|^bed$|^bed_block$/, [0, 0, 0, 16, 9, 16]],
  [/^(soul_)?lantern$/, [5, 0, 5, 11, 9, 11]],
  [/^flower_pot$|^potted_/, [5, 0, 5, 11, 6, 11]],
  [/^cake$|candle_cake$/, [1, 0, 1, 15, 8, 15]],
  [/candle$/, [7, 0, 7, 9, 6, 9]],
  [/^(enchanting_table|enchantment_table)$/, [0, 0, 0, 16, 12, 16]],
  [/campfire$/, [0, 0, 0, 16, 7, 16]],
  [/^(skeleton_skull|wither_skeleton_skull|zombie_head|player_head|creeper_head|dragon_head|piglin_head|skull)$/, [4, 0, 4, 12, 8, 12]],
  [/^(dirt_path|grass_path|farmland)$/, [0, 0, 0, 16, 15, 16]],
  [/^stonecutter$/, [0, 0, 0, 16, 9, 16]],
  [/^(end_portal_frame|ender_portal_frame)$/, [0, 0, 0, 16, 13, 16]],
  [/^(torch|soul_torch|redstone_torch|unlit_redstone_torch|lit_redstone_torch|copper_torch)$/, [7, 0, 7, 9, 10, 9]],
  [/^brewing_stand$/, [7, 0, 7, 9, 14, 9]],
  [/^(sea_pickle|turtle_egg)$/, [6, 0, 6, 10, 6, 10]],
  [/^conduit$/, [5, 5, 5, 11, 11, 11]],
  [/^dragon_egg$/, [1, 0, 1, 15, 16, 15]]
]

// items that are not blocks (block items use the block colours below)
const ITEM_COLORS = [
  [/^(wooden|wood)_(sword|pickaxe|axe|shovel|spade|hoe)$/, [150, 115, 70]],
  [/^stone_(sword|pickaxe|axe|shovel|spade|hoe)$/, [125, 125, 125]],
  [/^iron_(sword|pickaxe|axe|shovel|spade|hoe|helmet|chestplate|leggings|boots|ingot|nugget|horse_armor)$|^shears$|^bucket$|_bucket$|^chainmail_/, [216, 216, 216]],
  [/^golde?n?_(sword|pickaxe|axe|shovel|spade|hoe|helmet|chestplate|leggings|boots|ingot|nugget|horse_armor)$|^gold_(ingot|nugget)$/, [246, 208, 61]],
  [/^leather/, [140, 85, 50]],
  [/^(cooked_|baked_)/, [168, 100, 60]],
  [/^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|tropical_fish|pufferfish|raw_\w+|fish)$/, [222, 120, 110]],
  [/^(bread|wheat)$/, [205, 160, 80]],
  [/^apple$|berries$/, [210, 40, 40]],
  [/^carrot$|carrot_on_a_stick/, [240, 140, 30]],
  [/^(potato|poisonous_potato)$/, [200, 170, 90]],
  [/^(cookie|pumpkin_pie)$/, [200, 140, 80]],
  [/^(paper|map|filled_map|empty_map)$/, [232, 228, 214]],
  [/^(book|writable_book|written_book|book_and_quill)$/, [120, 70, 40]],
  [/^enchanted_book$/, [150, 80, 200]],
  [/arrow$/, [180, 180, 180]],
  [/^(string|feather|snowball|bone_meal|sugar)$/, [238, 238, 238]],
  [/^bone$/, [230, 226, 210]],
  [/^(gunpowder|flint|flint_and_steel)$/, [90, 90, 90]],
  [/^rotten_flesh$/, [150, 80, 60]],
  [/^ender_pearl$/, [30, 110, 100]],
  [/^(ender_eye|eye_of_ender)$/, [80, 160, 70]],
  [/^(blaze_rod|blaze_powder|fire_charge)$/, [250, 180, 40]],
  [/^(slime_ball|experience_bottle)$/, [120, 210, 90]],
  [/^(coal|charcoal)$/, [40, 40, 40]],
  [/^nether_star$/, [240, 240, 200]],
  [/^totem/, [230, 200, 80]],
  [/^(elytra|phantom_membrane)$/, [140, 140, 170]],
  [/^shield$/, [130, 100, 70]],
  [/potion|^glass_bottle$|^dragon_breath$/, [120, 90, 200]],
  [/compass$/, [160, 160, 170]],
  [/^(clock|watch)$/, [220, 190, 60]],
  [/^name_tag$/, [200, 190, 160]],
  [/^(lead|leash)$/, [170, 140, 100]],
  [/^saddle$/, [130, 80, 50]],
  [/minecart$/, [150, 150, 160]],
  [/boat$|_raft$/, [150, 115, 70]],
  [/^egg$/, [230, 220, 190]],
  [/firework/, [200, 60, 60]],
  [/spawn_egg$/, [180, 160, 120]],
  [/^(stick|bow|crossbow|fishing_rod|bowl)$/, [137, 103, 63]],
  [/^trident$/, [80, 160, 150]],
  [/^(heart_of_the_sea|nautilus_shell)$/, [60, 120, 200]],
  [/^(honey_bottle|honeycomb)$/, [251, 185, 52]],
  [/^(melon_slice|beetroot|beetroot_soup)$/, [190, 50, 50]],
  [/stew$/, [150, 110, 70]],
  [/^(ink_sac|glow_ink_sac)$/, [30, 30, 40]],
  [/^cake$|candle_cake$/, [235, 225, 215]],
  [/^candle$/, [225, 210, 160]],
  [/^flower_pot$/, [150, 80, 55]]
]

// the 16 dye colours, in Minecraft's metadata order (wool, stained glass, ... on 1.8 - 1.12)
const DYES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const DYE_RGB = {
  white: [234, 236, 237],
  orange: [241, 118, 20],
  magenta: [189, 68, 179],
  light_blue: [58, 175, 217],
  yellow: [248, 198, 40],
  lime: [112, 185, 26],
  pink: [238, 141, 172],
  gray: [63, 68, 72],
  light_gray: [142, 142, 135],
  silver: [142, 142, 135],
  cyan: [21, 138, 145],
  purple: [122, 42, 173],
  blue: [53, 57, 157],
  brown: [114, 72, 41],
  green: [85, 110, 28],
  red: [161, 39, 35],
  black: [21, 21, 26]
}
const DYED_1_8 = new Set(['wool', 'stained_glass', 'stained_glass_pane', 'stained_hardened_clay', 'carpet', 'concrete', 'concrete_powder', 'bed', 'banner', 'standing_banner', 'wall_banner'])
const WOODS_1_8 = { planks: ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'], log: ['oak', 'spruce', 'birch', 'jungle'], log2: ['acacia', 'dark_oak'], leaves: ['oak', 'spruce', 'birch', 'jungle'], leaves2: ['acacia', 'dark_oak'], wooden_slab: ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'], sapling: ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'] }

// first matching entry wins: [pattern, [r, g, b]]
const COLORS = [
  [/^(cave_|void_)?air$/, [0, 0, 0]],
  [/water|bubble_column/, [63, 118, 228]],
  [/lava/, [207, 92, 20]],
  [/grass_block|^grass$|tall_grass|short_grass|^fern|large_fern|tallgrass|vine|lily_pad|waterlily|seagrass|kelp/, [95, 159, 53]],
  [/^dirt$|rooted_dirt|^dirt_path|grass_path|farmland/, [134, 96, 67]],
  [/coarse_dirt/, [119, 85, 59]],
  [/podzol/, [91, 63, 24]],
  [/mycelium/, [111, 99, 105]],
  [/^mud$|mud_bricks|packed_mud/, [100, 82, 66]],
  [/red_sandstone/, [186, 99, 29]],
  [/red_sand/, [190, 102, 33]],
  [/sandstone/, [216, 203, 155]],
  [/^sand$|suspicious_sand/, [219, 207, 163]],
  [/gravel/, [131, 127, 126]],
  [/^clay$/, [160, 166, 179]],
  [/coal_ore/, [105, 105, 105]],
  [/iron_ore/, [136, 129, 122]],
  [/gold_ore/, [145, 133, 106]],
  [/diamond_ore/, [121, 141, 140]],
  [/emerald_ore/, [108, 136, 115]],
  [/lapis_ore/, [99, 110, 132]],
  [/redstone_ore/, [133, 107, 107]],
  [/copper_ore/, [124, 125, 120]],
  [/quartz_ore/, [117, 65, 62]],
  [/iron_block|iron_bars|iron_door|iron_trapdoor|heavy_weighted/, [220, 220, 220]],
  [/gold_block|gold|light_weighted/, [246, 208, 61]],
  [/diamond/, [98, 237, 228]],
  [/emerald/, [42, 203, 87]],
  [/lapis/, [30, 67, 140]],
  [/redstone_block/, [175, 24, 5]],
  [/redstone|^repeater|^comparator/, [170, 20, 10]],
  [/coal_block/, [16, 15, 15]],
  [/quartz/, [235, 229, 222]],
  [/copper/, [192, 107, 79]],
  [/netherite/, [66, 61, 63]],
  [/amethyst/, [133, 97, 191]],
  [/bedrock/, [85, 85, 85]],
  [/crying_obsidian/, [32, 10, 60]],
  [/obsidian/, [20, 18, 30]],
  [/deepslate/, [80, 80, 82]],
  [/tuff/, [108, 109, 102]],
  [/calcite/, [223, 224, 220]],
  [/granite/, [149, 103, 85]],
  [/diorite/, [188, 188, 188]],
  [/andesite/, [136, 136, 136]],
  [/mossy/, [100, 120, 90]],
  [/moss/, [89, 109, 45]],
  [/cobble/, [122, 122, 122]],
  [/stone_brick|stonebrick/, [122, 121, 122]],
  [/nether_brick/, [44, 21, 26]],
  [/brick/, [150, 97, 83]],
  [/netherrack/, [97, 38, 38]],
  [/soul_sand/, [81, 62, 50]],
  [/soul_soil/, [75, 57, 46]],
  [/glowstone/, [171, 131, 84]],
  [/magma/, [142, 63, 31]],
  [/basalt/, [80, 81, 86]],
  [/blackstone/, [42, 36, 41]],
  [/crimson_nylium/, [130, 31, 31]],
  [/warped_nylium/, [43, 114, 101]],
  [/nether_wart_block/, [114, 2, 2]],
  [/warped_wart_block/, [22, 119, 121]],
  [/shroomlight/, [240, 146, 70]],
  [/end_stone/, [219, 222, 158]],
  [/purpur/, [169, 125, 169]],
  [/dark_prismarine/, [51, 91, 75]],
  [/prismarine/, [99, 156, 151]],
  [/sea_lantern/, [172, 199, 190]],
  [/wet_sponge/, [171, 181, 70]],
  [/sponge/, [195, 192, 74]],
  [/hay/, [166, 136, 38]],
  [/pumpkin|jack_o_lantern|lit_pumpkin/, [198, 118, 24]],
  [/melon/, [111, 145, 30]],
  [/cactus/, [85, 127, 43]],
  [/sugar_cane|^reeds$/, [148, 192, 101]],
  [/bamboo/, [93, 144, 19]],
  [/tnt/, [182, 63, 46]],
  [/bookshelf/, [117, 94, 59]],
  [/crafting_table|chest|barrel|note_?block|jukebox|loom|lectern|composter|beehive|bee_nest|fletching|cartography|smithing/, [140, 100, 55]],
  [/furnace|smoker|dispenser|dropper|observer|piston|stonecutter|grindstone/, [115, 115, 115]],
  [/anvil|hopper|cauldron/, [68, 68, 68]],
  [/enchant/, [100, 40, 40]],
  [/beacon/, [117, 220, 215]],
  [/spawner/, [36, 46, 62]],
  [/slime/, [111, 192, 91]],
  [/honey/, [251, 185, 52]],
  [/cobweb|^web$/, [228, 233, 234]],
  [/blue_ice/, [116, 167, 253]],
  [/packed_ice/, [141, 180, 250]],
  [/ice/, [145, 183, 253]],
  [/snow/, [249, 254, 254]],
  [/nether_portal|^portal$/, [130, 40, 220]],
  [/end_portal|end_gateway/, [10, 10, 20]],
  [/glass/, [200, 220, 235]],
  [/terracotta|hardened_clay/, [152, 94, 67]],
  [/torch|lantern|campfire|fire/, [255, 190, 80]],
  [/rail/, [120, 110, 100]],
  [/poppy|rose|red_flower|red_tulip|red_mushroom/, [200, 40, 30]],
  [/dandelion|yellow_flower|sunflower/, [230, 210, 40]],
  [/flower|tulip|orchid|allium|azure|daisy|cornflower|lily|peony|lilac/, [200, 120, 200]],
  [/mushroom/, [150, 110, 80]],
  [/wheat|carrots|potatoes|beetroots|crops|nether_wart|cocoa/, [150, 170, 50]],
  [/dead_bush|deadbush/, [120, 90, 50]],
  [/sign|ladder|door|fence|trapdoor|button|lever|pressure_plate/, [150, 115, 70]],
  [/oak/, [162, 130, 78]],
  [/spruce/, [114, 84, 48]],
  [/birch/, [196, 179, 123]],
  [/jungle/, [160, 115, 80]],
  [/acacia/, [168, 90, 50]],
  [/dark_oak/, [66, 43, 20]],
  [/mangrove/, [117, 54, 48]],
  [/cherry/, [226, 178, 172]],
  [/crimson/, [101, 48, 70]],
  [/warped/, [43, 104, 99]],
  [/stone|smooth|chiseled|polished/, [125, 125, 125]],
  [/^log|_log$|_wood$|planks|wooden/, [140, 105, 60]]
]
const LOG_RGB = { oak: [109, 85, 50], spruce: [58, 37, 16], birch: [216, 215, 210], jungle: [85, 67, 25], acacia: [103, 96, 86], dark_oak: [60, 46, 26], mangrove: [84, 66, 36], cherry: [54, 33, 44] }
const LEAF_RGB = { oak: [60, 120, 40], spruce: [60, 95, 60], birch: [100, 140, 60], jungle: [50, 130, 30], acacia: [80, 120, 40], dark_oak: [50, 105, 30], mangrove: [80, 120, 40], cherry: [230, 170, 200], azalea: [90, 120, 50] }

function hashColor (name) {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619)
  const hue = (h >>> 0) % 360
  const [r, g, b] = hslToRgb(hue / 360, 0.35, 0.5)
  return [r, g, b]
}

function hslToRgb (h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

function scale (rgb, k) {
  return rgb.map(v => Math.max(0, Math.min(255, Math.round(v * k))))
}

/** Approximate colour of a block or item by its registry name (and 1.8 - 1.12 metadata). */
function colorFor (name, metadata = 0) {
  name = String(name || '')
  if (DYED_1_8.has(name)) {
    const rgb = DYE_RGB[DYES[metadata & 15]]
    return name.includes('clay') ? scale(rgb, 0.72) : rgb
  }
  if (name === 'dye' || name === 'ink_sac' || name === 'ink_sack') return DYE_RGB[DYES[15 - (metadata & 15)]]
  if (WOODS_1_8[name]) {
    const wood = WOODS_1_8[name][name.startsWith('log') || name.startsWith('leaves') ? metadata & 3 : metadata & 7] || 'oak'
    if (name.startsWith('log')) return LOG_RGB[wood]
    if (name.startsWith('leaves')) return LEAF_RGB[wood]
    return colorFor(`${wood}_planks`)
  }
  // dyed blocks on 1.13+: red_wool, lime_stained_glass_pane, ...
  for (const dye of ['light_blue', 'light_gray', ...DYES]) {
    if (name.startsWith(dye + '_') && !/(red_sand|red_nether|red_mushroom|brown_mushroom|black_stone|blackstone)/.test(name)) {
      const rgb = DYE_RGB[dye]
      return /terracotta/.test(name) ? scale(rgb, 0.72) : rgb
    }
  }
  if (/_log$|_wood$|_stem$|_hyphae$/.test(name)) {
    const wood = Object.keys(LOG_RGB).find(w => name.includes(w))
    if (wood) return LOG_RGB[wood]
  }
  if (/leaves/.test(name)) {
    const wood = Object.keys(LEAF_RGB).find(w => name.includes(w))
    return LEAF_RGB[wood || 'oak']
  }
  for (const [re, rgb] of ITEM_COLORS) if (re.test(name)) return rgb
  for (const [re, rgb] of COLORS) if (re.test(name)) return rgb
  return hashColor(name)
}

/**
 * How the POV draws a block: { color, kind }.
 * `block` is a minecraft-data block ({ name, boundingBox, transparent }).
 */
const DIRT = [134, 96, 67]
const lighten = (c, f) => c.map(v => Math.min(255, Math.round(v * f)))

/** block -> { color, top?, kind, alpha } (top: a different colour for the top face) */
function blockAppearance (block, metadata = 0) {
  if (!block) return { color: [0, 0, 0], kind: KIND.AIR, alpha: 1 }
  const name = block.name
  if (/^(cave_|void_)?air$|^barrier$|structure_void|^light$|moving_piston|piston_extension/.test(name)) return { color: [0, 0, 0], kind: KIND.AIR, alpha: 1 }
  const color = colorFor(name, metadata)
  let kind
  let alpha = 1
  let top = null
  const box = BOXES.find(([re]) => re.test(name))
  if (box) return { color, kind: KIND.BOX, alpha, box: box[1].map(v => v / 16) }
  if (/water|bubble_column|lava/.test(name)) { kind = KIND.LIQUID; alpha = /lava/.test(name) ? 1 : 0.62 } else if (/pane|iron_bars|^chain$|fence|_wall$|^cobblestone_wall$|end_rod|lightning_rod/.test(name) && !/fence_gate/.test(name)) {
    kind = KIND.POST
    if (/glass/.test(name)) alpha = 0.5
  } else if (/glass|^ice$|frosted_ice|nether_portal|^portal$|slime_block|honey_block/.test(name)) { kind = KIND.GLASS; alpha = /^ice$|frosted/.test(name) ? 0.7 : /portal/.test(name) ? 0.6 : 0.42 } else if (/carpet|snow_layer|^snow$|pressure_plate|rail|lily_pad|waterlily|daylight_detector|repeater|comparator|end_portal$|redstone_wire|trapdoor/.test(name)) kind = KIND.THIN
  else if (/slab/.test(name) && !/double/.test(name)) kind = KIND.SLAB
  else if (block.boundingBox === 'empty') kind = /sign|banner|button|lever|tripwire|^string$|cobweb|^web$|wall_|skull|head/.test(name) ? KIND.AIR : KIND.PLANT
  else kind = KIND.SOLID
  // blocks whose top looks different from their sides
  if (kind === KIND.SOLID) {
    if (/^grass_block$|^grass$|^mycelium$|^podzol$/.test(name)) { top = color; return { color: DIRT, top, kind, alpha } }
    if (/(^|_)(log|stem)$|^log2?$/.test(name) && !/stripped/.test(name)) top = lighten(color, 1.45)
  }
  return top ? { color, top, kind, alpha } : { color, kind, alpha }
}

module.exports = { KIND, colorFor, blockAppearance, DYES }
