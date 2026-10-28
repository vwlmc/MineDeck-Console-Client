# Security and privacy

MineDeck holds the keys to people's Minecraft accounts, so it is built to keep them on the user's own computer and nowhere else. This document explains exactly what MineDeck stores, where its network traffic goes, how the app is locked down, what it can't protect against, and how to check a build.

## The promise

- **Nobody but you gets your accounts.** There is no MineDeck server or account system. The developers and whoever publishes a build receive nothing: no tokens, no usernames, no statistics, no crash reports.
- **MineDeck never sees your Microsoft password.** You sign in on Microsoft's website.
- **Account tokens only travel to Microsoft, Xbox Live and Mojang**, the same places the official Minecraft launcher sends them.
- **Everything else stays on your PC**, and the sensitive parts are encrypted by your operating system.

## How signing in works

MineDeck uses Microsoft's *device code* sign-in, the same "enter a code at microsoft.com/link" flow used by consoles and the Minecraft launcher on other devices:

1. MineDeck asks `login.live.com` for a short code (no account information is involved yet).
2. You open `https://www.microsoft.com/link` in your own browser, enter the code, and sign in on Microsoft's page. MineDeck never sees what you type there.
3. Microsoft gives MineDeck an access token and a refresh token for Xbox Live. MineDeck trades these at Xbox Live (`user.auth.xboxlive.com`, `device.auth.xboxlive.com`, `title.auth.xboxlive.com`, `xsts.auth.xboxlive.com`) and then at Minecraft (`api.minecraftservices.com`) for a Minecraft access token, your profile (name and UUID) and the chat-signing key pair Minecraft issues to every player.

The Microsoft client ID is `00000000441cc96b`, the public ID that `minecraft-protocol` and `mineflayer` use by default. The code is in [`src/main/auth/microsoft.js`](src/main/auth/microsoft.js).

## Where your data goes

| Destination | When | What is sent |
| --- | --- | --- |
| `login.live.com` | Signing in, and refreshing a sign-in (about once a day) | The device code, or the Microsoft refresh token |
| `*.auth.xboxlive.com` | After signing in or refreshing | Microsoft and Xbox tokens, signed with a key that only exists on your PC |
| `api.minecraftservices.com` | After signing in or refreshing | Xbox token, then your Minecraft token to read your profile and chat-signing key |
| `sessionserver.mojang.com` | Each time an account joins an online-mode server | Your Minecraft token, your UUID and a hash identifying that connection. This is how every Minecraft client proves who it is; the server then checks with Mojang. |
| `sessionserver.mojang.com`, `textures.minecraft.net` | Showing faces in the account list (cached for a day) | Your account's public UUID. No token. |
| The Minecraft server you choose | When you connect, ping or test a server | What any Minecraft client sends: your username and UUID, chat messages and commands you send, game packets. **Never your tokens.** |

Nothing else. MineDeck has no telemetry, analytics, advertising, crash reporting, remote configuration or update checks. Chromium's background downloads are switched off too: the spellchecker's dictionary download, which Electron does by default, is pointed at an address inside the app so it never leaves your PC.

You can check this yourself: the only network code is in `src/main/auth/microsoft.js` (sign-in), `src/main/skins.js` (faces) and the Minecraft protocol library (game connections and the session server). The window has no network access at all (see below).

## What is stored on your PC

Everything lives in one folder: `%APPDATA%\MineDeck` on Windows (`~/Library/Application Support/MineDeck` on macOS, `~/.config/MineDeck` on Linux). **Privacy & data → Open data folder** opens it.

| File | Contents | Protection |
| --- | --- | --- |
| `accounts.json` | For each account: an internal ID, name, UUID, and its **tokens** (Microsoft, Xbox, Minecraft, the chat-signing key pair and the Xbox proof key) | Tokens are encrypted with the OS (below). Names and UUIDs are public information. |
| `config.json` | Settings, your server list, window size, which accounts were online when MineDeck closed | Join commands (which may contain a `/login` password) are encrypted like tokens. The rest is not secret. |
| `skins/` | Skin images used for the faces in the account list | Public images |
| `logs/` | Chat logs, **only if you turn them on** | Plain text. Passwords typed after `/login`, `/register` and similar commands are replaced with `••••••` before anything is shown or logged. |
| Other folders (`Local Storage`, `Cache`, …) | Chromium's own files: a few window preferences such as which accounts are ticked and recent chat input (password commands are never kept) | Not secret |

Outside that folder MineDeck only writes the desktop and Start menu shortcuts if you ask for them, and, if you turn on *Start MineDeck when you sign in to Windows*, a standard per-user startup entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) that holds nothing but the path to `MineDeck.exe`. Turning the option off removes it.

**Staying signed in:** you sign in once per account. The saved tokens are renewed automatically (the Minecraft token about once a day, using Microsoft's long-lived refresh token), so accounts stay signed in across MineDeck restarts and PC restarts without anything being stored in plain text.

**Encryption:** tokens and join commands go through Electron's `safeStorage`, which uses **DPAPI** on Windows, the **Keychain** on macOS and the desktop **keyring** (libsecret or KWallet) on Linux. On Windows this ties the data to your Windows user account: other users on the PC, or someone who copies the folder to another computer, can't decrypt it. If an operating system has no secure storage (for example Linux without a keyring), MineDeck keeps sign-ins **in memory only** and never writes them to disk, shows a warning, and asks you to sign in again after a restart.

**Removing everything:** **Privacy & data → Remove all accounts & data** disconnects every account and deletes the saved sign-ins, skins and chat logs. Removing a single account deletes its tokens. Deleting the data folder removes everything. To also cancel the sign-ins on Microsoft's side (for example if you think a PC was compromised), change your Microsoft account password or use the option to sign out everywhere in the security settings at `account.microsoft.com`.

## How the app is locked down

MineDeck is an [Electron](https://www.electronjs.org/) app: a main process (Node.js) and a window (Chromium). Only the main process ever holds tokens. The window, which displays text from game servers, is treated as untrusted:

- **Sandboxed window:** `sandbox`, `contextIsolation` and `webSecurity` on; `nodeIntegration` off. The window has no Node.js, no file system and no access to the main process's memory.
- **Narrow bridge:** the preload script exposes exactly two functions, `call(name, ...args)` and `onEvent(callback)`. `call` only accepts names from a fixed list in `src/main/main.js`, only from MineDeck's own page (`minedeck://app/`), and every argument is checked (IDs against a pattern, text length-limited, settings validated against allowed values and ranges, server addresses parsed strictly). Nothing on that list returns a token.
- **No HTML from servers:** chat, player names, MOTDs and kick messages are converted to plain text segments in the main process and put on screen with `textContent`. There is no `innerHTML` anywhere in MineDeck's code.
- **Strict Content Security Policy:** scripts and styles only from the app itself, no inline scripts, `connect-src 'none'` (the window can't make network requests), no frames, objects or forms. Every web request from the window to anything but the app's own files is also blocked in the main process.
- **No navigation or pop-ups:** the window can't navigate away, open new windows or attach webviews. Links open in your normal browser only if they match a short allow list (`microsoft.com/link`, `minecraft.net`, `account.microsoft.com`, `github.com`).
- **Permissions denied:** camera, microphone, notifications, geolocation and every other browser permission are refused. The one exception is locking the mouse pointer for the POV view, allowed only for MineDeck's own page.
- **Electron fuses** (switches compiled into the app's executable) in release builds:
  - `RunAsNode` **off**: `ELECTRON_RUN_AS_NODE` can't turn `MineDeck.exe` into a general-purpose Node.js.
  - `EnableNodeOptionsEnvironmentVariable` **off**: `NODE_OPTIONS` can't inject code.
  - `EnableNodeCliInspectArguments` **off**: `--inspect` can't attach a debugger to the main process.
  - `OnlyLoadAppFromAsar` **on** and `EnableEmbeddedAsarIntegrityValidation` **on**: only the packaged app (`resources/app.asar`) runs, and it must match a SHA-256 hash stored inside `MineDeck.exe`.
  - `EnableCookieEncryption` **on**, `GrantFileProtocolExtraPrivileges` **off**.
- **Developer tools are disabled** in release builds (unless started with `--devtools`, which still gives no access to tokens: they never reach the window).
- **Malicious servers:** a game server only ever talks to the protocol library. It can't reach the window except as plain text, can't make MineDeck send tokens anywhere, and oversized compressed packets ("decompression bombs") are rejected.
- **Files written safely:** settings and accounts are written to a temporary file and then renamed, with owner-only permissions where the OS supports them.

## The POV view

The POV tab shows one account's surroundings and lets you control it. It doesn't change anything above:

- The window still never sees sign-in tokens. The main process sends it plain data only: block colours and shapes, positions of nearby players and mobs, your hotbar and menu contents, and chat text. Every action the window asks for (look, walk, click a menu slot, ...) goes through one function in `src/main/pov.js` that checks each value before passing it to the account's connection.
- Nothing new is sent anywhere: the POV uses the account's existing connection to the server you chose, the same packets a game client sends when you look, walk or click.
- MineDeck's window is allowed exactly one browser permission, locking the mouse pointer while you control the POV, and only for MineDeck's own page (`minedeck://app`). Every other permission (camera, microphone, notifications, ...) is still refused.
- The 3D view is drawn with WebGL from MineDeck's own code. No Minecraft textures or other Mojang assets are downloaded or included.

## Macros

- A macro is data, not code: a list of steps from a fixed menu (say, wait, click a menu item, walk...). `src/main/macros.js` checks every macro (typed in the editor, imported, or from a template) against that list in the main process, drops anything else and limits every value, before it is saved or run. A macro can't read or write files, reach the internet, or touch sign-ins; it can only do things an account could do in the game, on the server it's already on.
- Matching chat with `*` patterns is done by MineDeck's own matcher (`src/main/wildcard.js`), which takes time proportional to the text, so a shared macro can't freeze MineDeck with a crafted pattern.
- macros.json is encrypted with the OS like sign-ins, because a macro may contain a password (`/login ...`). Passwords in commands are masked in the chat window and logs, as always. On a system without secure storage, macros are saved as plain text and the Macros tab says so.
- Imported macros start with their automatic start switched off, so nothing runs until you've looked at it.
- Limits: a macro's messages and commands are at least 0.3 seconds apart per account, loops can't run faster than 20 times a second, and a macro that starts itself more than 20 times a minute from chat is switched off.

## What MineDeck can't protect you from

Being honest about limits matters as much as the protections:

- **Malware already running as your Windows user.** DPAPI protects data from *other* users and other computers, not from programs running as you. Such malware could ask Windows to decrypt MineDeck's tokens, just as it could read your browser's saved passwords. Keep your PC clean.
- **Modified copies of MineDeck.** The protections above only hold for genuine builds. Download releases only from the official repository, check the SHA-256 against `SHA256SUMS.txt`, or verify the build attestation (below). Builds are not code-signed, so Windows can't do this check for you.
- **The servers you join.** They see what any Minecraft client shows them (username, UUID, IP address, chat). Join commands and chat you send go to that server.
- **Rules and bans.** Using several accounts, bots or anti-AFK is against the rules of some servers. That is a policy matter, not a security one, but it is your account on the line.

## Checking a build

- **Read the code.** The app is plain JavaScript: start with `src/main/main.js` (the bridge), `src/main/auth/microsoft.js` (sign-in) and `src/main/secure-store.js` (encryption).
- **Run the tests.** `npm test` includes integration tests against local Minecraft test servers, including one that stands in for Mojang's session server and fails if any other host is contacted. The end-to-end test checks the window's isolation (no `require`, no `process`, only two bridge functions, blocked network and blocked unknown calls).
- **Verify a release.** Releases made by [`.github/workflows/release.yml`](.github/workflows/release.yml) are built on GitHub's servers from the tagged source and come with `SHA256SUMS.txt` and a signed build provenance attestation:
  ```bash
  gh attestation verify MineDeck-1.2.5-setup.exe --repo vwlmc/MineDeck-Console-Client
  ```
- **Build it yourself** with `npm ci && npm run dist:win` and compare behaviour, or simply use your own build.

The 1.0.x zips were assembled outside of GitHub Actions (see *About the first zips* in the README); every dependency source and commit is listed in `deps.lock.json` and every packaging step is in `scripts/package_win_offline.mjs`.

## Reporting a vulnerability

Please report security problems privately through the repository's **Security → Report a vulnerability** page (GitHub private vulnerability reporting) rather than in a public issue. Include what you found, how to reproduce it, and which version you used.
