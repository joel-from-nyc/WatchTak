# WatchTak

A Discord bot for following [PlayTak](https://playtak.com) games.

WatchTak keeps one read-only guest connection to PlayTak open and mirrors it
into a Discord server: it lists open seeks and games in progress, announces
new seeks and game starts in a channel, and follows a chosen game live in its
own thread with a board image and PTN notation for every move.

The bot never writes anything to PlayTak. It sends no seeks, no moves, and no
account actions. It only listens to the broadcasts every guest connection
receives, and subscribes to a game's move stream when someone asks to watch it.

## Commands

| Command         | What it does                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ping`         | Health check with round-trip latency.                                                                                                                                |
| `/list`         | Lists games currently in progress.                                                                                                                                   |
| `/seeks`        | Lists open public seeks.                                                                                                                                             |
| `/watch <game>` | Follows a live game in a thread. Takes a game number or a partial player name, with autocomplete. `/spectate` is an alias. With no argument it behaves like `/list`. |
| `/expand here`  | Inside a game thread: attaches board images to any catch-up summaries that were posted without them.                                                                 |
| `/expand new`   | Inside a game thread: builds a separate replay thread with one board per move, then mirrors the live game into it.                                                   |
| `/help`         | Describes every command.                                                                                                                                             |

Moderator commands (default permission: Manage Channels):

| Command                                    | What it does                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/announce on\|off\|quiet\|noguest\|users` | Keeps a live list of joinable human seeks in the channel, removing each as it is taken or cancelled, and posts a notice with a Watch button when one becomes a game. `quiet` suppresses game notices; `noguest` and `users` filter them. Survives restarts. |
| `/showbots on\|off`                        | Whether games with a bot on either side get a game notice.                                                                                                                                                                                                  |
| `/rating human:<n> bot:<n>`                | Only post game notices for games with a registered human rated at least `human`, against another human or a bot rated at least `bot`. Overrides `/showbots` and the announce filters (but not `quiet`). `/rating off` clears it.                            |
| `/prune duplicates\|threads\|messages`     | Removes the bot's own stale messages and threads: duplicate watch threads, threads and notices that no longer match the channel's settings, and day-old threads nobody chatted in. Live games are never touched.                                            |

Stale notices and unused threads are also cleaned up automatically every
30 minutes in every channel where `/announce` has been configured. A finished
game's thread is archived 24 hours after its last message.

## Setup

Requires Node 22.

1. **Create the Discord application** at
   https://discord.com/developers/applications.
   - Bot tab: Reset Token and copy it. This is `DISCORD_TOKEN`.
   - General Information: copy the Application ID. This is `DISCORD_CLIENT_ID`.
   - If the app is private, set Installation > Install Link to "None".

2. **Install dependencies.**

   ```bash
   npm install
   ```

   Board rendering uses `tps-ninja`, which depends on the native `canvas`
   package. If npm blocks its install script, run
   `npm install-scripts approve canvas` and install again. Board images use
   the Roboto font when it is installed on the host, and fall back to the
   system default otherwise.

3. **Configure the environment.**

   ```bash
   cp .env.example .env
   ```

   Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` (the
   server ID; right-click the server icon with Developer Mode on). Commands are
   registered to that one server, which makes changes show up instantly. A bot
   instance is meant to live in a single server; run a second instance with its
   own `.env` to serve another.

4. **Invite the bot.** In OAuth2 > URL Generator choose the `bot` and
   `applications.commands` scopes, and these bot permissions: Send Messages,
   Read Message History, Create Public Threads, Send Messages in Threads,
   Manage Threads (to archive finished game threads), Manage Messages (lets
   `/prune` bulk-delete instead of deleting one message at a time). Open the
   generated URL and add the bot to the server.

5. **Register the slash commands.** Run this again whenever a command's name,
   description, or options change.

   ```bash
   npm run deploy-commands
   ```

6. **Run it.**
   ```bash
   npm run dev
   ```
   The log shows `Logged in as ...`, `Connected to PlayTak.`, and the number of
   ratings loaded.

### Running as a service

For an always-on deployment, build once and run the compiled output:

```bash
npm run build
npm start
```

`npm start` runs `node dist/index.js`. Point any process manager (systemd,
NSSM on Windows, pm2, Docker) at that command with the project directory as the
working directory, since `.env` and `data/` are resolved relative to it. The
bot handles `SIGINT`/`SIGTERM` for a clean stop. After pulling a new version:
rebuild, re-run `deploy-commands` if commands changed, and restart the process.

To run two instances from one checkout (for example production and testing),
give each its own env file and pass it as the first argument:
`node dist/index.js .env.testing`. Per-instance state files in `data/` (or
`DATA_DIR`) are namespaced by `DISCORD_GUILD_ID`.

## Project structure

```
src/
  index.ts             Entry point: Discord login, command dispatch, button handlers, shutdown
  deploy-commands.ts   Registers the slash commands with Discord
  commands/            One file per slash command (spectate.ts is an alias of watch.ts)
  playtak/
    client.ts          The single guest WebSocket connection to PlayTak
    protocol.ts        Parses PlayTak's line-based wire protocol into typed events
    shared.ts          Singleton wiring the connection and registries together
    registry.ts        Live in-memory view of active games
    seekRegistry.ts    Live in-memory view of open seeks
    ratings.ts         Player ratings, polled from playtak.com's rating list
    gameArchive.ts     Finished games, fetched from PlayTak's public archive
    watcher.ts         Watch-a-game lifecycle: threads, live moves, reconnects, sweep
    lowTime.ts         Low-time countdown warnings
    threadClose.ts     24h close/archive lifecycle for finished game threads
    threadLookup.ts    Finding a game's thread and reading back what it shows
    catchup.ts         Catch-up summary messages that /expand fills with boards
    announcer.ts       /announce: live seek list per channel
    seekToGame.ts      Correlates a removed seek with the game it became
    autoPrune.ts       Silent periodic cleanup of stale notices and threads
    pruneRules.ts      Scanning and deletion helpers shared by /prune and autoPrune
    announceStore.ts, showBotsStore.ts, ratingStore.ts   Per-channel settings persisted to data/
    ptn.ts, ptnLink.ts, result.ts, boardImage.ts, format.ts   Notation, links, results, rendering, text
    presence.ts        "Watching N games on PlayTak" status
  scripts/             Standalone tools: protocol probes and a one-off avatar setter
  types/               Ambient types for tps-ninja
assets/                The bot's profile picture
```

## Development

```bash
npm run check          # format check, build, and tests
npm run build          # type-check and compile to dist/
npm test               # unit tests (node:test, run through ts-node)
npm run format         # apply Prettier
npm run dev            # run from source with ts-node
npm run set-avatar     # upload assets/watchtak-icon.png as the bot's avatar
```

Keep secrets in `.env` (gitignored). Per-channel settings are stored as JSON
files in `data/` (gitignored), or in `DATA_DIR` if set.

## License

[MIT](LICENSE)
