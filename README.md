# NokBot — Tak/PlayTak Discord Bot

A TypeScript Discord bot (discord.js) for the abstract board game Tak and
the [PlayTak.com](https://playtak.com) community. It keeps a single
read-only guest connection to PlayTak open and bridges it into Discord:
browsing open seeks and in-progress games, and watching a specific game
live in a thread as it's played, with board images and PTN notation.

The bot never writes anything to PlayTak — no seeks, no moves, no account
actions. It only listens to the public seek/game-list broadcasts every
guest connection receives, and (when someone runs `/watch`) subscribes to
one game's move stream to mirror it into Discord.

## Setup

1. **Create the Discord application**
   - Go to https://discord.com/developers/applications → New Application.
   - Under "Bot", click "Reset Token" and copy it — this is `DISCORD_TOKEN`.
   - Copy the "Application ID" from General Information — this is `DISCORD_CLIENT_ID`.
   - Under Installation, if the app is private (not a Public Bot), set the
     default Install Link to "None".

2. **Install dependencies**
   ```bash
   npm install
   ```
   This pulls in `tps-ninja` (board image rendering), which depends on the
   native `canvas` package. If its install script isn't auto-approved by
   npm, run `npm install-scripts approve canvas`.

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. For fast local testing,
   also set `DISCORD_GUILD_ID` to your test server's ID (right-click the
   server icon with Developer Mode on in Discord settings → Advanced).

4. **Invite the bot to your server**
   Build an invite URL in the Developer Portal under OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Read Message History`, `Create Public Threads`,
     `Send Messages in Threads`, `Manage Threads` (needed to archive/lock
     watch threads when a game ends)
   Open the generated URL and add the bot to your test server.

5. **Register the slash commands**
   ```bash
   npm run deploy-commands
   ```
   Run this again any time you add or change a command.

6. **Run the bot**
   ```bash
   npm run dev
   ```
   You should see `Logged in as YourBot#1234`.

7. **Try it**
   - `/ping` — health check.
   - `/seeks` — see what open seeks anyone can join right now.
   - `/list` — see what games are currently in progress.
   - `/watch <game>` (or `/spectate`) — pass a game ID or a player
     name (partial names work, matched anywhere in the name) to open a
     thread and follow that game live. Leave it blank to behave like `/list`.
   - `/announce` — toggle a live list of joinable seeks in the current
     channel, posted as humans open them and removed as they're taken.

## Project structure

```
src/
  index.ts               # Bot entry point: logs in, wires up commands and the PlayTak connection
  deploy-commands.ts     # One-off script to register slash commands with Discord
  commands/
    ping.ts               # Health-check command
    list.ts                # List in-progress PlayTak games
    watch.ts, spectate.ts  # Watch a game live in a thread (+ alias)
    seeks.ts                # List open joinable seeks
    announce.ts             # Toggle the live joinable-seeks list in a channel
    help.ts                # Full command/alias explanations
  playtak/
    client.ts             # The single guest WebSocket connection to PlayTak
    protocol.ts            # Wire-protocol parser -> typed events
    shared.ts               # Singleton wiring the connection + registries together
    registry.ts, seekRegistry.ts  # Live in-memory views of active games / open seeks
    gamesReply.ts, seeksReply.ts  # Shared reply text builders for the commands above
    announcer.ts            # Live joinable-games list: post on open, delete when taken
    watcher.ts              # Thread lifecycle: create/reuse, live moves, reconnect, sweep
    ptn.ts, ptnLink.ts, result.ts, boardImage.ts  # Notation, links, results, board rendering
  scripts/
    playtak-probe.ts, playtak-client-probe.ts  # Standalone protocol-debugging scripts
  types/
    tps-ninja.d.ts          # Ambient types for the untyped tps-ninja package
```

## Where to go from here

- **Move to Tak Talk**: this bot is currently developed and tested on a
  private Discord server. Once it's solid, invite it to the Tak Talk
  Discord server (worth giving the community a heads-up first, since it's
  a small community and guest connections are meant for humans).
- **Deployment**: it's self-hosted.
- **playtak-ui deep links**: PlayTak has no shareable join/spectate URLs
  today. A small PR to `USTakAssociation/playtak-ui` adding `?game=`/`?seek=`
  deep links would let `/watch` and future features link straight to a game
  instead of just narrating it.
- **Separate project idea**: a small web app teaching new players Tak,
  embedding PTN Ninja's board via its documented `postMessage` API. Not
  part of this repo.
