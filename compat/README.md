# Compatibility modules

These tiny modules are **only used by the offline build script**
(`scripts/assemble_deps.py`). They stand in for a few npm packages that could
not be downloaded when the bundled build was assembled (the npm registry was
unreachable, so every dependency was assembled from its GitHub source instead).

A normal build (`npm ci && npm run dist`, which the GitHub release workflow
uses) installs the real packages from npm and **does not use this folder**.

| Module | Real package | Why a stand-in is safe |
| --- | --- | --- |
| `node-fetch` | node-fetch 2.x | Forwards to the `fetch()` that is built into Electron's Node.js. Only used for the Mojang session "join" request (yggdrasil) and by prismarine-realms (never used). |
| `uuid` | uuid | yggdrasil only calls `uuid.v4()`, which this forwards to Node's `crypto.randomUUID()`. Only used by Mojang-account login code that MineDeck never calls. |
| `minecraft-folder-path` | minecraft-folder-path | Returns the `.minecraft` folder path. Imported by minecraft-protocol's built-in login code, which MineDeck never calls. MineDeck never reads or writes that folder. |
| `endian-toggle` | endian-toggle | Byte-swaps a buffer. Only used by minecraft-protocol's *server* ping code (MineDeck is a client). |
| `uint4` | uint4 | Reads/writes 4-bit values in a buffer. Used for 1.8 chunk light data. |
| `xxhash-wasm` | xxhash-wasm | **Not used.** prismarine-chunk loads its Bedrock Edition code (which hashes chunks with xxhash) alongside the Java Edition code. MineDeck only joins Java Edition servers, so a placeholder that refuses to run is provided. |
| `prismarine-auth` | prismarine-auth | **Not used.** MineDeck has its own, smaller sign-in code in `src/main/auth/`. minecraft-protocol imports this module when it loads, so a placeholder that refuses to run is provided. |

Every stand-in has a `package.json` whose `description` starts with
`MineDeck compat module`, so they are easy to find in the built app.
