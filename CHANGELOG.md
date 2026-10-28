# Changelog

## 1.2.5

- **GitHub's automatic build, second fix.** One test (the one that checks a sign-in token is only ever sent to Mojang's session server) relied on a detail of the hand-built zip: there, the library that sends web requests (node-fetch) is a small stand-in that the test can watch. A normal install from npm has the real node-fetch, so on GitHub the test's stand-in for Mojang was bypassed and the test timed out. The test now works with both. The app itself is unchanged.
- The end-to-end UI test now waits for each result (up to a few seconds) instead of checking after a fixed pause, so a slower build machine can't make it fail.

## 1.2.4

- **Fixes GitHub's automatic build.** MineDeck asked for version 2.10.0 of prismarine-nbt (the library that reads Minecraft's item and world data), but that version and 2.9.0 were never published to npm, where GitHub installs libraries from: the library's publishing broke in March 2026. MineDeck now accepts any version from 2.8.0 up. The only change after 2.8.0 is for reading compressed world files, which MineDeck doesn't do. The full test suite passes with the released versions npm offers (prismarine-nbt 2.8.0, protodef 1.19.0) as well as with the newer ones in the hand-built zip.

## 1.2.3

- MineDeck's home is now [github.com/vwlmc/MineDeck-Console-Client](https://github.com/vwlmc/MineDeck-Console-Client): the *Source code* button in **Privacy & data** opens it, and the README links to the official downloads.
- Release builds: GitHub's own builds (installer and portable app, with a signed record of how they were built) are now also added to a release that was created on GitHub's website.

## 1.2.2

- **Macros:** a macro added from a template, made with *New macro*, duplicated or imported no longer shows up twice in the list (it was one macro listed twice, which is why deleting one removed both).

## 1.2.1

- **POV: the controls card no longer gets stuck on the screen.** If Windows refused to hand over the mouse once (for example when clicking the view while MineDeck's window wasn't focused yet, or right after pressing Esc), the POV switched to "drag to look around" for good and kept its instructions in the middle of the view. Now every click tries again to take the mouse, dragging looks around in the meantime, and the instructions are a small bar at the top of the view that disappears while you're in control (the key list folds away after the first time). W A S D also work after clicking into the view without the mouse lock, and Esc always gives the mouse back.

## 1.2.0

**Macros.** A new Macros tab lets accounts do things by themselves.

- **Editor:** pick steps from a menu and fill in the blanks. Steps: say a message or command; wait (a set or random time, for a chat message, or for a menu); click a menu item by its name; right-click; attack what's in front or the nearest hostile mob, mob, player or named entity; fish; eat; hold, drop or pick a hotbar slot; look, walk, walk to coordinates, jump, sneak, sprint; respawn.
- **Logic:** Repeat (times or forever), If / Otherwise (health, hunger, inventory items, an open menu, recent chat, random chance, comparing text), variables (`{account}`, `{x}`, `{time}`, `{random:1-10}`, `{1}` from `*` in chat patterns...), notes and pop-ups, running another macro, stop, disconnect.
- **Triggers:** run it with ▶, an F-key or an account's ⋯ menu, or let it start by itself when an account joins, when chat says something, every few minutes, when a menu opens, when the account dies, or when health gets low.
- Runs on all online accounts or chosen ones, staggered; can loop, and restart by itself after a reconnect. The editor shows which step each account is on, with a log of what happened.
- 12 templates (hub menus, AFK fishing, mob farm, auto-eat, daily reward, sell all, accept teleports, away reply, auto-confirm menus, join alerts, leave on low health, walk back and forth).
- Share macros as text and import other people's. Imported macros start with their automatic start off.
- Limits that protect accounts from spam kicks and MineDeck from runaway macros: commands at least 0.3 s apart per account, loops no faster than 20 per second, and a macro that starts itself more than 20 times a minute from chat is switched off.
- Anti-AFK pauses on an account while a macro runs on it.
- Adding accounts: the sign-in window now explains how to add a second account when the browser keeps signing in to the first one (use a private window).
- Security: macros are data, not code. Every macro (typed, imported or from a template) is checked in the main process against a fixed list of steps, and macros.json is encrypted with Windows (DPAPI) because a macro may contain a `/login` password. *Remove all accounts & data* deletes macros too.
- New tests: the `*` pattern matcher, checks on saved and imported macros, encryption of macros.json, and macros running against local test servers on 1.8.8 and 1.20.4 (chat, waiting for chat, menus, loops, conditions, variables, walking, all triggers, restarting after a reconnect, runaway protection). The end-to-end test builds a macro in the editor and runs it with its button and its F-key.

## 1.1.0

**POV: see and control an account without a game launcher.** A new POV tab shows the world around one account in 3D and lets you take over:

- **Look around** with the mouse (click the view to take the mouse, `Esc` to give it back), **walk** with W A S D, jump (`Space`), sneak (`Shift`) and sprint (`Ctrl`). Left click hits a mob or breaks the block you're looking at; right click uses or places what you're holding and opens doors, chests and the like. 1-9 or the mouse wheel pick a hotbar slot.
- **Server menus** (confirmation screens, shops, server selectors, any chest-style menu) open over the view with each item's name and description. Click, right-click and Shift+click work as in the game, and you can see what you're carrying on the cursor. `E` opens your own inventory.
- When a server opens a menu for any account, the chat window says so and a notice offers to open it in the POV.
- **Chat and commands** from inside the POV, sent from the account you're viewing (`T` to talk, `/` for a command, arrow keys for history). That account's chat is shown over the view like in the game.
- Health, hunger and level, titles and action bar messages, name tags of players and holograms, and a *Respawn* button when auto-respawn is off.

**Clickable chat.** Chat buttons from servers (`[ACCEPT]`, `[Click to confirm]`, `[Vote]`...) now work in the chat window and in the POV: clicking runs the button's command from the account that received the message (when several accounts got it, a menu lets you pick one or all). Buttons that suggest a command put it in the message box, links are copied to the clipboard (MineDeck doesn't open web pages by itself), and hover texts show as tooltips.

- Blocks, items and mobs are drawn as coloured shapes, shaded like the game's lighting. MineDeck doesn't include Minecraft's textures (they belong to Mojang). Needs WebGL 2; without it menus, chat, the hotbar and movement still work.
- The POV follows its account through reconnects: after a kick or a server restart the view comes back by itself when the account rejoins.
- Works on every supported version from 1.8 to 26.1.2 (1.7.10 accounts can still chat but have no POV). Tested against local test servers on 1.8.8, 1.12.2, 1.16.5, 1.20.4, 1.21.4, 1.21.8 and 26.1: the world, walking, menus, custom item names and lore, and respawning.
- Anti-AFK pauses for the account you're steering in the POV.
- Security: the only browser permission MineDeck's window has is locking the mouse pointer for the POV, and only for its own page. The POV gets plain data (block colours, positions, item names) from the main process; it never sees sign-in tokens. See SECURITY.md.

## 1.0.2

Fixes for real servers, found on a 1.8.9 factions server where chat and commands never arrived and the account was disconnected about 30 seconds after joining:

- **Resource packs on 1.8 and 1.9:** answering a server's resource pack sent a packet without the pack's hash, which broke the connection: from then on nothing MineDeck sent reached the server, until the server timed the account out. MineDeck now answers resource packs itself, with the right fields for every version. Declining a pack is fixed the same way on 1.8, 1.9 and 1.20.3+.
- **Respawning on 1.7.10 and 1.8:** auto-respawn sent a respawn packet those versions couldn't encode, with the same effect. Fixed, together with the arm swing (anti-AFK) on 26.1, by translating values to the form each version expects.
- **A broken connection is noticed at once:** if a packet can't be sent, MineDeck now closes the connection right away and auto-reconnect takes over, instead of showing the account as online while nothing goes through.
- **One unreadable packet no longer freezes an account:** if MineDeck fails to handle a packet from the server, it skips that packet (and says so once in the chat window) instead of silently stopping receiving.
- New tests for all of the above on 1.7.10 to 26.1, including a simulated busy factions server.
- Credits: "made by vwl" in the status bar, the README, the license and MineDeck.exe's file details.

## 1.0.1

- **Start with Windows:** new option in Settings → App. MineDeck starts in the background when you sign in (in the tray if "Close button minimizes to tray" is on). Together with *Reconnect accounts on startup*, accounts come back online by themselves after a PC restart. Turning it on offers to switch on reconnecting too.
- The list of accounts to reconnect is now saved continuously while MineDeck runs, so it is right even when Windows restarts the PC without letting MineDeck close (for example after an update).
- The app now says clearly that each account only signs in once: the sign-in is saved encrypted on the PC and renewed in the background.
- Desktop and Start menu shortcuts made from the portable `.exe` point at the downloaded file rather than its temporary copy.
- New test: a signed-in account survives a restart without signing in again, and a forced restart brings the online accounts back.

## 1.0.0

- First release.
