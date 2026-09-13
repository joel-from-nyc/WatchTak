# WatchTak

A Discord bot (TypeScript, discord.js v14) that follows Tak games on
PlayTak.com. See README.md for what it does, every command, and setup. This
file covers what an agent or contributor needs to change it safely.

## Architecture

- One guest WebSocket connection to PlayTak (`src/playtak/client.ts`), created
  once by `initPlaytak()` in `shared.ts`. Every feature subscribes to that
  client's `event` stream; nothing opens a second connection.
- `protocol.ts` parses PlayTak's line protocol into typed events. Field orders
  follow the server source (`USTakAssociation/playtak-api`). The bot sends
  `Protocol 2` before `Login Guest`; v2 adds a bot flag to seek lines,
  reports an open seek's opponent as `"0"` (normalized to `''`), and sends
  clock updates as `Game#<no> Timems` in milliseconds instead of `Time` in
  seconds. The parser accepts both.
- `registry.ts` / `seekRegistry.ts` are in-memory views of active games and
  open seeks. PlayTak replays the full game and seek lists on every
  (re)connect and never sends removals for anything that ended while the bot
  was disconnected, so both reconcile against the replay ~2s after connect.
- `watcher.ts` owns a watched game's thread: history replay on `Observe`,
  live move posts, reconnect catch-up, low-time warnings, and the 24h
  close/archive lifecycle. Thread names embed `(#<gameNo>)` so a restarted
  process can recover its threads from Discord alone; a periodic sweep
  reconciles every open thread against live state.
- `catchup.ts` defines the ≤10-ply "Moves 3W-7B" summary messages posted
  when a thread starts mid-game. `/expand here` later edits board images onto
  them (10 is Discord's per-message attachment cap).
- `announcer.ts` runs `/announce`; `seekToGame.ts` matches a removed seek to
  the game it became by player name within a 5s window, since the protocol
  carries no link between the two.
- `ratings.ts` polls `https://playtak.com/ratinglist.json` every 20 minutes.
  The wire protocol carries no ratings. A rating of 0 means unrated. The
  list's bot flag supplements bot detection from seek lines.
- `gameArchive.ts` fetches finished games from
  `https://api.playtak.com/v1/games-history/:id` for Review threads and
  `/expand` on finished games. Move tokens match the live wire format.
- `pruneRules.ts` holds the scanning/deletion primitives shared by `/prune`
  and `autoPrune.ts`. Deletion batches through `bulkDelete`, falling back to
  one-at-a-time for messages over two weeks old or when Manage Messages is
  missing.
- `announceStore.ts`, `showBotsStore.ts`, `ratingStore.ts` persist per-channel
  settings as JSON files in `data/`, namespaced by `DISCORD_GUILD_ID`.
- `boardImage.ts` renders boards with `tps-ninja` (native `canvas`). Wire komi
  is in half-points; divide by 2 before rendering.

## Conventions

- Strict TypeScript (`tsconfig.json`). Don't loosen it. Run `npm run build`
  after any change.
- One command per file in `src/commands/`, exporting `data` and `execute`
  (and `autocomplete` where an option autocompletes). Register new commands
  in both `src/index.ts` and `src/deploy-commands.ts`.
- Aliases are separate command files reusing the primary's `execute`
  (`spectate.ts`). Autocomplete must be declared on each registration.
- Command descriptions are capped at 100 characters by Discord. Keep them
  terse; `help.ts` carries the fuller text, one line per command.
- Commands whose output is a point-in-time statement reply ephemerally.
  The only public replies are `/announce`'s "now on" banner and `/watch`'s
  thread link.
- Timestamps use Discord `<t:...>` tags (viewer-local time). They don't
  render inside code blocks, so they go outside the fence.
- Secrets live in `.env` (gitignored). Never print or commit token values.

## Constraints

- Never send anything to PlayTak that creates or affects a game. The client
  only sends `Protocol 2`, `Login Guest`, `PING`, `Observe`, and `Unobserve`.
- Keep slash-command registration guild-scoped (`DISCORD_GUILD_ID` set). A
  bot instance lives in exactly one server; a second server means a second
  instance with its own `.env`.
- Don't set the avatar on startup. `npm run set-avatar` exists for that;
  Discord rate-limits avatar changes and the service restarts on every deploy.
- Deployment is a Windows service running `node dist/index.js`. A source edit
  does nothing until `npm run build` and a service restart; a command change
  also needs `npm run deploy-commands`.

## Direction

Take direction from the maintainer on what to build next. Don't add bot
features unprompted.
