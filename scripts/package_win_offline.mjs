#!/usr/bin/env node
/*
 * Builds the portable Windows zip of MineDeck without electron-builder.
 *
 * The normal way to build MineDeck is `npm ci && npm run dist:win` (or the
 * GitHub release workflow), which uses electron-builder. This script exists
 * for the hand-assembled release, which was built on a machine that could not
 * reach the npm registry. It does the same things electron-builder does, in
 * plain steps you can read:
 *
 *   1. checks the official Electron zip against Electron's SHASUMS256.txt
 *   2. extracts it and removes Electron's demo app (default_app.asar)
 *   3. packs MineDeck (src, assets, node_modules, licenses) into resources/app.asar
 *   4. renames electron.exe to MineDeck.exe and sets its icon, file details and
 *      the app.asar integrity hash
 *   5. flips Electron "fuses" to switch off debugging back doors (see SECURITY.md)
 *   6. zips the folder and prints its SHA-256
 *
 * Build tools (not shipped): resedit + pe-library (exe resources) and
 * @electron/asar, passed with --tools <dir containing node_modules>.
 *
 * usage: node scripts/package_win_offline.mjs --electron-zip electron-vX-win32-x64.zip
 *          --shasums SHASUMS256.txt --tools <dir> --out <dir>
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values: args } = parseArgs({
  options: {
    'electron-zip': { type: 'string' },
    shasums: { type: 'string' },
    tools: { type: 'string' },
    out: { type: 'string' }
  }
})
for (const k of ['electron-zip', 'shasums', 'tools', 'out']) {
  if (!args[k]) throw new Error(`missing --${k}`)
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const OUT = path.resolve(args.out)
const STAGE = path.join(OUT, 'MineDeck')
const APP_STAGE = path.join(OUT, 'app-staging')
const KEEP_LOCALES = new Set(['en-US.pak', 'en-GB.pak'])

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const run = (cmd, argv, cwd) => {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed`)
}
const step = (s) => console.log(`\n== ${s}`)

// ------------------------------------------------------------ 1. verify Electron
step('Verify Electron download')
const zipName = path.basename(args['electron-zip'])
const expected = fs.readFileSync(args.shasums, 'utf8').split('\n')
  .map(l => l.trim().split(/\s+\*?/)).find(([, name]) => name === zipName)?.[0]
const actual = sha256(args['electron-zip'])
if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${zipName}: ${actual} vs ${expected}`)
console.log(`${zipName} sha256 ${actual} (matches SHASUMS256.txt)`)
if (!zipName.includes(`v${pkg.devDependencies.electron}-`)) throw new Error(`expected Electron ${pkg.devDependencies.electron}`)

// ------------------------------------------------------------ 2. extract
step('Extract Electron')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })
run('unzip', ['-q', path.resolve(args['electron-zip']), '-d', STAGE])
fs.rmSync(path.join(STAGE, 'resources', 'default_app.asar'), { force: true })
// like electron-builder: Electron's own license gets a clear name, MineDeck's sits next to it
fs.renameSync(path.join(STAGE, 'LICENSE'), path.join(STAGE, 'LICENSE.electron.txt'))
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE.txt'))
for (const f of fs.readdirSync(path.join(STAGE, 'locales'))) {
  if (!KEEP_LOCALES.has(f)) fs.rmSync(path.join(STAGE, 'locales', f))
}

// ------------------------------------------------------------ 3. app.asar
step('Pack resources/app.asar')
const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(APP_STAGE, rel), { recursive: true })
fs.mkdirSync(APP_STAGE, { recursive: true })
for (const rel of ['src', 'assets', 'node_modules', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) copy(rel)
// the shipped package.json only needs what Electron reads at runtime
const runtimePkg = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
  license: pkg.license,
  author: pkg.author,
  ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
  private: true,
  dependencies: pkg.dependencies
}
fs.writeFileSync(path.join(APP_STAGE, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n')
const files = []
;(function walk (dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) throw new Error(`unexpected symlink ${p}`)
    files.push(p)
    if (e.isDirectory()) walk(p)
  }
})(APP_STAGE)
const asar = await import(pathToFileURL(path.join(args.tools, 'node_modules/@electron/asar/lib/asar.js')))
const asarPath = path.join(STAGE, 'resources', 'app.asar')
await asar.createPackageFromFiles(APP_STAGE, asarPath, files)
console.log(`app.asar: ${files.length} entries, ${(fs.statSync(asarPath).size / 1e6).toFixed(1)} MB`)

// ------------------------------------------------------------ 4. MineDeck.exe
step('MineDeck.exe: icon and file details')
const exePath = path.join(STAGE, 'MineDeck.exe')
fs.renameSync(path.join(STAGE, 'electron.exe'), exePath)
const ResEdit = await import(pathToFileURL(path.join(args.tools, 'node_modules/resedit/dist/index.js')))
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
const res = ResEdit.NtExecutableResource.from(exe)
const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'icon.ico')))
const [group] = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map(i => i.data))
const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
const [major, minor, patch] = VERSION.split('.').map(Number)
const lang = { lang: 1033, codepage: 1200 }
vi.removeStringValue(lang, 'SquirrelAwareVersion')
vi.setStringValues(lang, {
  CompanyName: pkg.author,
  FileDescription: 'MineDeck',
  FileVersion: VERSION,
  InternalName: 'MineDeck',
  LegalCopyright: `Made by ${pkg.author}. MIT License.`,
  OriginalFilename: 'MineDeck.exe',
  ProductName: 'MineDeck',
  ProductVersion: VERSION
})
vi.setFileVersion(major, minor, patch, 0, 1033)
vi.setProductVersion(major, minor, patch, 0, 1033)
vi.outputToResourceEntries(res.entries)
// ASAR integrity: Electron refuses to start if app.asar's header doesn't match
// this hash (each file inside has its own block hashes). Same resource layout
// as electron-builder and @electron/packager write.
const { headerString } = asar.getRawHeader(asarPath)
const asarHash = createHash('sha256').update(headerString).digest('hex')
res.entries.push({
  type: 'INTEGRITY',
  id: 'ELECTRONASAR',
  bin: Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: asarHash }])),
  lang: 1033,
  codepage: 1200
})
console.log(`app.asar header sha256 ${asarHash}`)
res.outputResource(exe)
fs.writeFileSync(exePath, Buffer.from(exe.generate()))

// ------------------------------------------------------------ 5. fuses
step('Electron fuses')
// https://www.electronjs.org/docs/latest/tutorial/fuses (wire format from @electron/fuses)
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
const FUSES = {
  0: ['RunAsNode', '0'], // ELECTRON_RUN_AS_NODE can't turn MineDeck.exe into a plain Node.js
  1: ['EnableCookieEncryption', '1'],
  2: ['EnableNodeOptionsEnvironmentVariable', '0'], // NODE_OPTIONS can't inject code
  3: ['EnableNodeCliInspectArguments', '0'], // no --inspect debugger on the process that holds tokens
  4: ['EnableEmbeddedAsarIntegrityValidation', '1'], // app.asar must match the hash inside MineDeck.exe
  5: ['OnlyLoadAppFromAsar', '1'], // only resources/app.asar is loaded, never a loose "app" folder
  7: ['GrantFileProtocolExtraPrivileges', '0']
}
const bin = fs.readFileSync(exePath)
const at = bin.indexOf(SENTINEL)
if (at === -1 || bin.indexOf(SENTINEL, at + 1) !== -1) throw new Error('expected exactly one fuse wire')
const wire = at + SENTINEL.length
if (bin[wire] !== 1) throw new Error(`unknown fuse wire version ${bin[wire]}`)
const count = bin[wire + 1]
for (const [i, [name, state]] of Object.entries(FUSES)) {
  if (Number(i) >= count) throw new Error(`fuse ${name} not in this Electron`)
  bin[wire + 2 + Number(i)] = state.charCodeAt(0)
}
fs.writeFileSync(exePath, bin)
console.log(`fuse wire: ${bin.subarray(wire + 2, wire + 2 + count).toString('latin1')}`)

// ------------------------------------------------------------ 6. zip
step('Zip')
fs.writeFileSync(path.join(STAGE, 'README.txt'), [
  `MineDeck ${VERSION} for Windows (64-bit)`,
  `Made by ${pkg.author}.`,
  '',
  'Start MineDeck.exe. Nothing needs to be installed. Keep this folder together:',
  'MineDeck.exe needs the files next to it. In Settings > App you can add',
  'MineDeck to your desktop and Start menu.',
  '',
  'This build is not code-signed, so the first time Windows may say',
  '"Windows protected your PC". Click "More info", then "Run anyway".',
  '',
  'Your accounts, servers and settings are stored in %APPDATA%\\MineDeck.',
  'Sign-in tokens are encrypted with your Windows user account (DPAPI) and',
  'are only ever sent to Microsoft, Xbox Live and Mojang.',
  '',
  'Uninstall: in MineDeck open Privacy & data > Remove all accounts & data,',
  'then delete this folder and %APPDATA%\\MineDeck.',
  '',
  'MineDeck is open source: MIT License (LICENSE.txt). Electron and Chromium',
  'licenses: LICENSE.electron.txt and LICENSES.chromium.html in this folder.',
  ''
].join('\r\n'))
fs.rmSync(APP_STAGE, { recursive: true, force: true })
const zipOut = path.join(OUT, `MineDeck-${VERSION}-win-x64.zip`)
run('zip', ['-q', '-r', '-9', '-X', zipOut, 'MineDeck'], OUT)
const zipSha = sha256(zipOut)
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), `${zipSha}  ${path.basename(zipOut)}\n`)
console.log(`${path.basename(zipOut)}  ${(fs.statSync(zipOut).size / 1e6).toFixed(1)} MB  sha256 ${zipSha}`)
