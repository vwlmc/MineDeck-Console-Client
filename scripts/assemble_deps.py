#!/usr/bin/env python3
"""
Offline dependency assembler for MineDeck.

The normal way to build MineDeck is `npm ci && npm run dist` (see README.md),
which installs every dependency from npm. This script exists for environments
where the npm registry is not reachable: it builds an equivalent node_modules
folder from each package's GitHub source (pinned to a commit), from published
copies of packages already on the machine, and from the small, documented
stand-ins in compat/.

Every source and commit used is written to deps.lock.json so the result can
be audited.

usage: assemble_deps.py <cache-dir> <node_modules-out> [--published DIR ...]
"""
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)

# name -> (github repo, git ref). Each ref is the release that was published
# to npm with that version: a release tag, or the "Release x.y.z" commit for
# packages whose releases are not tagged. Using the released code keeps this
# build identical to `npm install` of the same versions.
#
# The two exceptions are pinned to newer commits, and package.json asks npm for
# exactly the same commits: the latest releases (minecraft-protocol 1.68.0,
# mineflayer 4.39.0) can't join 1.21.2+ servers (no particleStatus in the
# client settings packet), get chat signing checksums wrong on 1.21.5+, and
# lack a guard against "decompression bomb" packets from a malicious server.
GITHUB = {
    'minecraft-protocol': ('PrismarineJS/node-minecraft-protocol', 'dacf62ef40cc559429537a303ac246ee9cede175'),
    'mineflayer': ('PrismarineJS/mineflayer', '5a252e6d258882b042e60e21c37d552cdf3b3380'),
    'prismarine-chat': ('PrismarineJS/prismarine-chat', '1.13.0'),
    'prismarine-nbt': ('PrismarineJS/prismarine-nbt', '02ee0e80f1b247622b117772c769bae4309c1d32'),  # Release 2.10.0
    'prismarine-registry': ('PrismarineJS/prismarine-registry', '1.12.0'),
    'prismarine-biome': ('PrismarineJS/prismarine-biome', '1.4.0'),
    'prismarine-block': ('PrismarineJS/prismarine-block', '1.23.0'),
    'prismarine-chunk': ('PrismarineJS/prismarine-chunk', '1.41.0'),
    'prismarine-entity': ('PrismarineJS/prismarine-entity', '2.6.0'),
    'prismarine-item': ('PrismarineJS/prismarine-item', '1.18.0'),
    'prismarine-physics': ('PrismarineJS/prismarine-physics', '1.11.1'),
    'prismarine-recipe': ('PrismarineJS/prismarine-recipe', '1.5.0'),
    'prismarine-windows': ('PrismarineJS/prismarine-windows', '2.10.0'),
    'prismarine-world': ('PrismarineJS/prismarine-world', '3.7.0'),
    'prismarine-realms': ('PrismarineJS/prismarine-realms', '1.6.0'),
    'mojangson': ('PrismarineJS/node-mojangson', '2.1.0'),
    'nearley': ('kach/nearley', 'aa39ac4ff36054b8c6276ce0c098e13dbb4a18a7'),  # 2.20.1
    'vec3': ('PrismarineJS/node-vec3', '0.1.9'),
    'yggdrasil': ('PrismarineJS/node-yggdrasil', '1.8.0'),
    'protodef': ('ProtoDef-io/node-protodef', '9ad8d34bb978637d99132a0af1f7f2ab3b282fb1'),  # Release 1.20.0
    'protodef-validator': ('ProtoDef-io/node-protodef-validator', '1.5.0'),
    'uuid-1345': ('scravy/uuid-1345', '1.0.2'),
    'macaddress': ('scravy/node-macaddress', '0.5.3'),
    'aes-js': ('ricmoo/aes-js', 'v3.1.2'),
    'buffer-equal': ('inspect-js/buffer-equal', 'v1.0.1'),
    'node-rsa': ('rzcoder/node-rsa', '1.1.1'),
    'typed-emitter': ('andywer/typed-emitter', 'v2.1.0'),
    'readable-stream': ('nodejs/readable-stream', 'v4.7.0'),
    'process': ('defunctzombie/node-process', 'v0.11.10'),
    'string_decoder': ('nodejs/string_decoder', 'v1.3.0'),
    'safe-buffer': ('feross/safe-buffer', 'v5.2.1'),
    'minecraft-data': ('PrismarineJS/node-minecraft-data', '3.117.0'),
}

# packages that need a different version underneath a specific parent
NESTED = {
    # prismarine-physics 1.11.1 requires vec3 ^0.2.0; everything else uses ^0.1.x
    'prismarine-physics/node_modules/vec3': ('PrismarineJS/node-vec3', '0.2.0'),
}

# lodash's per-method packages live in folders of the "npm-packages" branch
LODASH = ['lodash.merge', 'lodash.reduce']

# published (npm) copies that already exist on the build machine
PUBLISHED = ['ms', 'debug', 'ajv', 'fast-deep-equal', 'fast-json-stable-stringify',
             'json-schema-traverse', 'uri-js', 'punycode', 'smart-buffer', 'asn1', 'safer-buffer']

COMPAT = ['node-fetch', 'uuid', 'minecraft-folder-path', 'endian-toggle', 'uint4', 'prismarine-auth', 'xxhash-wasm']

# Where this tree knowingly differs from what `npm install` would produce.
# None of these affect code that MineDeck runs.
KNOWN_DIFFERENCES = {
    'node-rsa': 'minecraft-protocol asks for ^0.4.2, which has no release tag on GitHub; 1.1.1 is used. '
                'It is only used by minecraft-protocol\'s server code (MineDeck is a client; the tests use it for their local test server).',
    'typed-emitter': 'mineflayer asks for ^1.0.0, prismarine-windows for ^2.x; 2.1.0 is installed once. It only provides TypeScript types.',
    'not installed': 'Packages only needed by command-line tools, TypeScript or other platforms are left out: '
                     '@types/*, nearley\'s CLI dependencies (commander, moo, railroad-diagrams, randexp), '
                     'and readable-stream\'s browser polyfills (abort-controller, buffer, events: Node.js has these built in).',
}

SKIP_DIRS = {'.git', '.github', 'test', 'tests', 'docs', 'doc', 'examples', 'example', 'benchmark',
             'benchmarks', '.vscode', '.idea', 'coverage', 'readable-stream-test', 'eslint-plugin-local',
             'build-tools'}


def run(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {r.stderr.strip()[:400]}")
    return r.stdout.strip()


def clone(cache, repo, ref):
    key = repo.replace('/', '__') + ('@' + ref if ref else '')
    dest = os.path.join(cache, key)
    if not os.path.exists(dest):
        if ref and re.fullmatch(r'[0-9a-f]{40}', ref):
            # an exact commit: fetch just that commit
            os.makedirs(dest)
            run(['git', 'init', '-q'], cwd=dest)
            run(['git', 'fetch', '-q', '--depth', '1', f'https://github.com/{repo}', ref], cwd=dest)
            run(['git', 'checkout', '-q', 'FETCH_HEAD'], cwd=dest)
        else:
            cmd = ['git', 'clone', '-q', '--depth', '1']
            if ref:
                cmd += ['-b', ref]
            run(cmd + [f'https://github.com/{repo}', dest])
    sha = run(['git', 'rev-parse', 'HEAD'], cwd=dest)
    if ref and re.fullmatch(r'[0-9a-f]{40}', ref) and sha != ref:
        raise RuntimeError(f'{repo}: expected {ref}, got {sha}')
    return dest, sha


def fetch_submodules(cache, repo_dir, skip=()):
    """Shallow-fetch each git submodule at the exact commit its parent pins."""
    gm = os.path.join(repo_dir, '.gitmodules')
    if not os.path.exists(gm):
        return {}
    pinned = {}
    for line in run(['git', 'submodule', 'status'], cwd=repo_dir).splitlines():
        sha, path = line.strip().lstrip('-+ ').split()[:2]
        pinned[path] = sha
    urls = dict(re.findall(r'path = (\S+)\s+url = (\S+)', open(gm).read()))
    done = {}
    for path, url in urls.items():
        if path in skip:
            continue
        target = os.path.join(repo_dir, path)
        if not os.path.exists(os.path.join(target, '.git')):
            shutil.rmtree(target, ignore_errors=True)
            os.makedirs(target)
            run(['git', 'init', '-q'], cwd=target)
            run(['git', 'fetch', '-q', '--depth', '1', url, pinned[path]], cwd=target)
            run(['git', 'checkout', '-q', 'FETCH_HEAD'], cwd=target)
        done[path] = {'url': url, 'commit': pinned[path]}
    return done


def copy_tree(src, dst, keep_test=False):
    def ignore(d, names):
        skip = set()
        for n in names:
            if n in SKIP_DIRS and not (keep_test and n in ('test', 'tests')):
                skip.add(n)
        return skip
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=ignore, symlinks=False)


def build_minecraft_data(cache, out, lock):
    """node-minecraft-data + the data submodule, limited to Java Edition 1.7 .. 26.1."""
    pkg_dir = os.path.join(out, 'minecraft-data')
    node_pkg, _ = clone(cache, *GITHUB['minecraft-data'])
    pinned = None
    for line in run(['git', 'submodule', 'status'], cwd=node_pkg).splitlines():
        sha, path = line.strip().lstrip('-+ ').split()[:2]
        if path == 'minecraft-data':
            pinned = sha
    data_repo = os.path.join(cache, f'minecraft-data-data@{pinned}')
    if not os.path.exists(data_repo):
        os.makedirs(data_repo)
        run(['git', 'init', '-q'], cwd=data_repo)
        run(['git', 'remote', 'add', 'origin', 'https://github.com/PrismarineJS/minecraft-data'], cwd=data_repo)
        run(['git', 'config', 'core.sparseCheckout', 'true'], cwd=data_repo)
        run(['git', 'sparse-checkout', 'set', '--no-cone', '/data/dataPaths.json'], cwd=data_repo)
        run(['git', 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', pinned], cwd=data_repo)
        run(['git', 'checkout', '-q', 'FETCH_HEAD'], cwd=data_repo)
    paths = json.load(open(os.path.join(data_repo, 'data', 'dataPaths.json')))
    keep = {k: v for k, v in paths['pc'].items() if re.fullmatch(r'\d+\.\d+(\.\d+)?', k) and k != '0.30c'}
    folders = sorted({p for m in keep.values() for p in m.values()})
    sparse = ['/data/dataPaths.json', '/data/pc/common/', '/data/bedrock/common/', '/schemas/', '/README.md']
    sparse += [f'/data/{f}/' for f in folders]
    subprocess.run(['git', 'sparse-checkout', 'set', '--no-cone', '--stdin'], cwd=data_repo,
                   input='\n'.join(sparse), text=True, check=True)
    run(['git', 'checkout', '-q'], cwd=data_repo)
    lock['minecraft-data (data files)'] = {'source': 'github:PrismarineJS/minecraft-data',
                                           'commit': run(['git', 'rev-parse', 'HEAD'], cwd=data_repo),
                                           'note': f'Java Edition data for {len(keep)} versions (1.7 to 26.1)'}

    sub = os.path.join(pkg_dir, 'minecraft-data')
    os.makedirs(sub, exist_ok=True)
    shutil.copytree(os.path.join(data_repo, 'data'), os.path.join(sub, 'data'), dirs_exist_ok=True)
    shutil.copytree(os.path.join(data_repo, 'schemas'), os.path.join(sub, 'schemas'), dirs_exist_ok=True)
    shutil.copy(os.path.join(data_repo, 'README.md'), os.path.join(sub, 'README.md'))
    # only ship the Java Edition entries we kept
    json.dump({'pc': keep, 'bedrock': {}}, open(os.path.join(sub, 'data', 'dataPaths.json'), 'w'), indent=2)
    # generate data.js exactly like the package's own bin/generate_data.js
    run(['node', os.path.join(pkg_dir, 'bin', 'generate_data.js')], cwd=pkg_dir)


def compile_mojangson_grammar(cache, out, lock):
    """mojangson publishes grammar.js compiled from grammar.ne with nearleyc.
    The compiler needs "moo" (build time only; the compiled grammar does not use it)."""
    tools = os.path.join(cache, 'build_node_modules')
    if not os.path.exists(os.path.join(tools, 'moo')):
        src, sha = clone(cache, 'no-context/moo', 'v0.5.2')
        copy_tree(src, os.path.join(tools, 'moo'))
    script = r"""
// mirrors nearley/bin/nearleyc.js
const fs = require('fs')
const nearley = require('nearley/lib/nearley.js')
const Compile = require('nearley/lib/compile.js')
const generate = require('nearley/lib/generate.js')
const version = require('nearley/package.json').version
const file = process.argv[1]
const parser = new nearley.Parser(nearley.Grammar.fromCompiled(require('nearley/lib/nearley-language-bootstrapped.js')))
parser.feed(fs.readFileSync(file, 'utf8'))
parser.feed('\n')
const c = Compile(parser.results[0], { version, args: [file] })
fs.writeFileSync(process.argv[2], generate(c, 'grammar'))
"""
    d = os.path.join(out, 'mojangson')
    subprocess.run(['node', '-e', script, os.path.join(d, 'grammar.ne'), os.path.join(d, 'grammar.js')],
                   cwd=out, check=True, env={**os.environ, 'NODE_PATH': out + os.pathsep + tools})
    lock['mojangson'] = {**lock['mojangson'], 'note': 'grammar.js compiled from grammar.ne with nearley (moo v0.5.2 used at build time only)'}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    cache, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    published_dirs = []
    if '--published' in sys.argv:
        published_dirs = sys.argv[sys.argv.index('--published') + 1:]
    os.makedirs(cache, exist_ok=True)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    lock = {}

    for name, (repo, ref) in sorted(GITHUB.items()):
        src, sha = clone(cache, repo, ref)
        subs = fetch_submodules(cache, src, skip=('minecraft-data',))
        copy_tree(src, os.path.join(out, name), keep_test=(name == 'minecraft-data'))
        lock[name] = {'source': f'github:{repo}', 'ref': ref or 'default branch', 'commit': sha,
                      'version': json.load(open(os.path.join(src, 'package.json'))).get('version')}
        if subs:
            lock[name]['submodules'] = subs

    for path, (repo, ref) in NESTED.items():
        src, sha = clone(cache, repo, ref)
        copy_tree(src, os.path.join(out, path))
        lock[path] = {'source': f'github:{repo}', 'ref': ref, 'commit': sha}

    lodash = os.path.join(cache, 'lodash-npm-packages')
    if not os.path.exists(lodash):
        run(['git', 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', '-b', 'npm-packages',
             'https://github.com/lodash/lodash', lodash])
        subprocess.run(['git', 'sparse-checkout', 'set', '--no-cone', '--stdin'], cwd=lodash,
                       input='\n'.join(f'/{n}/' for n in LODASH), text=True, check=True)
        run(['git', 'checkout', '-q'], cwd=lodash)
    sha = run(['git', 'rev-parse', 'HEAD'], cwd=lodash)
    for n in LODASH:
        copy_tree(os.path.join(lodash, n), os.path.join(out, n))
        lock[n] = {'source': 'github:lodash/lodash (npm-packages branch)', 'commit': sha,
                   'version': json.load(open(os.path.join(lodash, n, 'package.json')))['version']}

    for n in PUBLISHED:
        for d in published_dirs:
            p = os.path.join(d, n)
            if os.path.isfile(os.path.join(p, 'package.json')):
                copy_tree(p, os.path.join(out, n))
                lock[n] = {'source': 'npm (published copy)',
                           'version': json.load(open(os.path.join(p, 'package.json')))['version']}
                break
        else:
            raise SystemExit(f'published package not found: {n}')

    for n in COMPAT:
        copy_tree(os.path.join(PROJECT, 'compat', n), os.path.join(out, n))
        lock[n] = {'source': 'compat (see compat/README.md)'}

    build_minecraft_data(cache, out, lock)
    compile_mojangson_grammar(cache, out, lock)

    # drop package-lock files and dev-only folders that were copied along
    for root, dirs, files in os.walk(out):
        for f in files:
            if f in ('package-lock.json', 'yarn.lock', '.npmrc', '.travis.yml', '.gitpod.yml'):
                os.remove(os.path.join(root, f))

    lock['_known_differences_from_npm'] = KNOWN_DIFFERENCES
    json.dump(lock, open(os.path.join(PROJECT, 'deps.lock.json'), 'w'), indent=2, sort_keys=True)
    print(f'assembled {len(lock) - 1} packages into {out}')


if __name__ == '__main__':
    main()
