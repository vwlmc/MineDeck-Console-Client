#!/usr/bin/env python3
"""
Writes THIRD_PARTY_NOTICES.md: the license of every package bundled with
MineDeck (everything in node_modules) plus Electron.

usage: python3 scripts/third_party_notices.py [node_modules dir]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
LICENSE_RE = re.compile(r'^(licen[cs]e|copying)([.-].*)?$', re.I)

MIT = """Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""

ELECTRON = """Copyright (c) Electron contributors
Copyright (c) 2013-2020 GitHub Inc.

""" + MIT


def repo_url(pkg):
    r = pkg.get('repository')
    url = r.get('url') if isinstance(r, dict) else r
    if not url:
        return ''
    url = re.sub(r'^git\+', '', url)
    url = re.sub(r'^git@github\.com:', 'https://github.com/', url)
    url = re.sub(r'^git\+?ssh://git@github\.com/', 'https://github.com/', url)
    url = re.sub(r'^(git|ssh)://', 'https://', url)
    url = re.sub(r'^github:', 'https://github.com/', url)
    url = re.sub(r'^https?://git@', 'https://', url)
    url = re.sub(r'^http://', 'https://', url)
    if re.fullmatch(r'[\w.-]+/[\w.-]+', url):  # npm shorthand "owner/repo"
        url = 'https://github.com/' + url
    return re.sub(r'\.git$', '', url)


def author(pkg):
    a = pkg.get('author')
    if isinstance(a, dict):
        a = a.get('name')
    return re.sub(r'\s*[<(].*$', '', a or '').strip()


def packages(nm):
    for root, dirs, files in os.walk(nm):
        if 'package.json' in files and os.path.basename(os.path.dirname(root)) == 'node_modules' or \
                ('package.json' in files and os.path.basename(os.path.dirname(os.path.dirname(root))) == 'node_modules'
                 and os.path.basename(os.path.dirname(root)).startswith('@')):
            yield root
        dirs[:] = [d for d in dirs if d == 'node_modules' or os.path.basename(root) == 'node_modules' or d.startswith('@')]


def main():
    nm = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(PROJECT, 'node_modules'))
    entries = []
    for d in sorted(set(packages(nm))):
        pkg = json.load(open(os.path.join(d, 'package.json')))
        if str(pkg.get('description', '')).startswith('MineDeck compat module'):
            entries.append((pkg['name'], None, pkg, 'compat', d))
            continue
        lic_files = sorted(f for f in os.listdir(d) if LICENSE_RE.match(f))
        text = open(os.path.join(d, lic_files[0]), encoding='utf-8', errors='replace').read().strip() if lic_files else None
        entries.append((pkg['name'], text, pkg, 'pkg', d))

    out = ['# Third-party notices', '',
           'MineDeck (made by vwl) is MIT licensed (see LICENSE). It is built on the open-source projects below.', '',
           'Packages whose source repository has no license file of its own are marked',
           '"license text: MIT License (below)"; the license comes from the package\'s',
           '`package.json`, and the standard text of that license is at the end of this file.', '']

    out += ['## Electron', '', 'MineDeck runs on [Electron](https://github.com/electron/electron) (MIT License).',
            'Electron includes Chromium, Node.js and other projects; their licenses are in',
            '`LICENSES.chromium.html` next to `MineDeck.exe` in every MineDeck build.', '',
            '```', ELECTRON, '```', '']

    out += ['## Bundled packages', '']
    out += ['| Package | Version | License | Source |', '| --- | --- | --- | --- |']
    for name, text, pkg, kind, d in entries:
        src = 'MineDeck (see `compat/README.md`)' if kind == 'compat' else (repo_url(pkg) or '')
        lic = pkg.get('license') or pkg.get('licenses') or 'see below'
        if isinstance(lic, list):
            lic = ', '.join(x.get('type', '?') if isinstance(x, dict) else str(x) for x in lic)
        nested = os.path.relpath(d, nm).replace(os.sep, '/')
        label = name if nested == name else f'{name} (under {nested.split("/node_modules/")[0]})'
        out.append(f'| {label} | {pkg.get("version", "")} | {lic} | {src} |')
    out.append('')

    out += ['## License texts', '']
    for name, text, pkg, kind, d in entries:
        if kind == 'compat':
            continue
        nested = os.path.relpath(d, nm).replace(os.sep, '/')
        out.append(f'### {nested.replace("/node_modules/", " > ")} {pkg.get("version", "")}')
        out.append('')
        if text:
            out += ['```', text, '```', '']
        else:
            who = author(pkg)
            lic = pkg.get('license') or 'MIT'
            note = f'{lic} License' if lic != 'BSD' else 'BSD License'
            out.append(f'License: {note}, declared in package.json{f" (author: {who})" if who else ""}. '
                       f'The source repository ({repo_url(pkg)}) has no separate license file. '
                       + ('License text: MIT License (below).' if lic == 'MIT' else ''))
            out.append('')

    out += ['## Code adapted from other projects', '',
            '`src/main/auth/microsoft.js` is adapted from [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth)',
            '(MIT License, Copyright (c) PrismarineJS), keeping only the device-code sign-in flow.', '']

    out += ['## MIT License', '', '```', MIT, '```', '']
    with open(os.path.join(PROJECT, 'THIRD_PARTY_NOTICES.md'), 'w') as f:
        f.write('\n'.join(out))
    print(f'wrote THIRD_PARTY_NOTICES.md ({len(entries)} packages)')


if __name__ == '__main__':
    main()
