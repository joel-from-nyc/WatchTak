# Project: NokBot — Tak/PlayTak Discord companion bot

## What this is
A Discord bot (TypeScript, discord.js v14) built around the abstract board
game Tak and the PlayTak.com community. It maintains a single read-only
guest connection to PlayTak and bridges it into Discord: browsing open
seeks and in-progress games, and watching a specific game live in a
dedicated thread as it's played, with board images and PTN notation. It's
self-hosted.

## Current state
Slash commands (registered guild-scoped for near-instant updates - each
bot instance only ever lives in one Discord server; testing happens on a
separate instance, not a second server on the same process):
- `/ping` — health check.
- `/list` — lists PlayTak games currently in progress.
- `/watch <game>` (also `/spectate`) — watches a live PlayTak game: opens (or
  reuses) a Discord thread, posts the board plus each move in PTN notation
  (with each player's remaining time) as it happens, and on game end
  announces the winner with a `ptn.ninja` link to the full game before
  archiving the thread 24 hours later. `<game>` accepts a game ID or a
  partial player name - matched anywhere in the name, not just the start -
  (ambiguous matches ask the user to be more specific); with no argument
  it behaves like `/list`.
- `/expand here|new` — run inside a game thread. Catch-up summaries
  (posted when a thread starts mid-game, or after a reconnect gap of more
  than 10 plies) are "Moves 3W-7B" chunk messages of ≤10 plies each, sized
  to Discord's 10-attachments-per-message cap. `here` edits each unfilled
  summary in place, attaching one board PNG per ply as a plain gallery (a
  takeback that rewrote a summarized move marks that summary stale instead
  of drawing wrong boards). `new` builds a separate "Replay: ... - game N"
  thread with one message+board per ply, then attaches it as a live mirror
  of the watch so both threads get subsequent moves (mirror is in-memory
  only: a restart orphans the replay thread and Discord's 24h auto-archive
  retires it; its name deliberately doesn't match the watcher's `(#N)`
  thread-name pattern so the sweep never adopts it). Games over 150 plies
  refuse `new` — the ptn.ninja link covers those. Reconnect gaps of ≤10
  plies never produce summaries at all: the watcher just draws each missed
  move inline, since that costs the same number of messages.
- `/seeks` — lists currently open public seeks (private challenges aimed
  at one specific opponent are excluded, since no one else can accept
  them). Lists bot and human seeks alike.
- `/announce <on|off>` — explicit on/off (not a toggle - `/announce` alone
  reports the current status without changing it), keeping a live list of
  joinable seeks: posts when a *human* opens a public seek and deletes
  that message once the seek is taken or cancelled, so the channel only
  ever shows what's actually joinable. Bot seeks are skipped (they sit
  open near-permanently and would drown out the rest). The on/off state
  persists across restarts (`announceStore.ts`, a small JSON file - not a
  database, since it's just a handful of channel ids); on startup the bot
  resumes announcing in any channel that was on, and on a graceful stop
  (`SIGINT`/`SIGTERM`) it deletes the "now on" confirmation message in
  each one first, since it's stale the instant the bot goes down.
- `/showbots <on|off>` — per-channel, persisted independently of
  `/announce` (`showBotsStore.ts`) so it survives that being off. When
  off, any game with a confirmed bot on either side is dropped from
  game-started notices. Bot *seeks* were already never announced, so
  this only affects game notices.
- `/rating human:<n> bot:<n>` — a standing per-channel override
  (`ratingStore.ts`): a human rated at least `human` playing a bot rated
  at least `bot` is always shown, beating `/showbots`, `noguest`, and
  `users`. It deliberately does *not* beat `quiet`, which means "no game
  notices here at all". `/rating off` clears it.
- `/help` — full explanation of every command and its aliases (Discord
  caps a command's own description at 100 characters, so this is the
  fuller version). Keep the per-command lines here terse.

## Architecture
- `src/playtak/client.ts` — the single guest WebSocket connection to
  `wss://playtak.com/ws`, shared by the whole bot via `shared.ts`'s
  singleton (`initPlaytak()`). It only ever sends `Protocol 2`, `Login
  Guest`, the keepalive `PING`, and per-watch `Observe`/`Unobserve` -
  never anything that creates or affects a game. `Protocol 2` must be sent
  before login (the server gates it on `player == null`) and is what makes
  Seek lines carry the trailing bot flag `/announce` relies on; note it
  also changes an empty `opponent` field to the literal "0" (normalized
  back to `''` by `protocol.ts`), and switches per-game clock updates from
  `Game#<no> Time <secs> <secs>` to `Game#<no> Timems <ms> <ms>` - easy to
  miss since it's a silent rename, not a new message type. `protocol.ts`
  parses both.
- `src/playtak/announcer.ts` — backs `/announce`. Dedupes by seek id
  because PlayTak replays every open seek as `Seek new` on each
  reconnect, which would otherwise re-announce the world every time the
  socket blips. `announceStore.ts` persists which channels are on.
- `src/playtak/protocol.ts` — parses PlayTak's line-based wire protocol
  into typed events. Field orders are confirmed against the server source
  (`USTakAssociation/playtak-api` on GitHub) and cross-checked against
  live traffic, not guessed.
- `src/playtak/registry.ts` / `seekRegistry.ts` — live in-memory views of
  active games and open seeks, kept in sync via protocol events, backing
  `/list` and `/seeks` without round-tripping to PlayTak on every command.
- `src/playtak/watcher.ts` — owns the whole watch-a-game lifecycle: thread
  creation/reuse, history-replay-vs-live-move detection, reconnect
  resubscription, and a periodic sweep that reconciles every open thread
  against live state (self-heals desyncs, closes threads for games that
  ended while the bot was offline). See that file's comments for why this
  replaces a persisted store. On a reconnect, a thread that was already
  being watched gets the moves it missed while disconnected drawn inline
  (board-per-move) when the gap is ≤10 plies, or posted as
  /expand-fillable chunk summaries plus one current-position board when
  it's larger - `WatchState.historyMode`'s `'reconnect'` case.
- `src/playtak/catchup.ts` — the chunk-summary vocabulary shared by
  `watcher.ts` (which posts them) and `commands/expand.ts` (which fills
  them). The design insight that unshelved `/expand`: Discord can't insert
  messages into a thread's past, but the tail *at catch-up time* is the
  right place in the timeline, and a bot may edit its own old messages to
  add attachments - so ≤10-ply chunk messages posted at catch-up time act
  as permanent slots `/expand here` later fills in place (10 is Discord's
  attachment cap per message; plain attachments, no embeds). The chunk
  header `Moves 3W-7B` doubles as the machine-readable marker both
  `/expand`'s scan and `findKnownPlyCount()`'s restart recovery parse.
- `src/playtak/ratings.ts` — player ratings, which the WebSocket protocol
  carries nowhere. Polls `https://playtak.com/ratinglist.json` (the same
  endpoint playtak.com's own ratings page loads, confirmed by reading its
  `js/ratinglist.js`) every 20 minutes into an in-memory map. A row is
  `[name(s), rating, activeRating, games, isBot]`; the name field can hold
  several space-separated aliases for one renamed account, so every token
  is keyed to the same entry, and a rating of `0` is PlayTak's own "not
  rated yet" sentinel. Its `isBot` flag also backs up `announcer.ts`'s
  `knownBotByName`, catching bots that only ever *accept* seeks and so
  never appear on a `Seek new` line of their own.
- `src/playtak/gameTimes.ts` — when this process saw each game start. The
  protocol has no start timestamp and the public archive only gains a
  record once a game has *finished*, so a game already running when the
  bot connects has no knowable start time and its "Started" line is
  omitted rather than guessed. The archive's `date` field is the game's
  start (ids are issued at start, and `date` never runs out of order with
  them); no end timestamp is stored anywhere.
- `src/playtak/ptn.ts`, `ptnLink.ts`, `result.ts`, `boardImage.ts` — PTN
  notation conversion, `ptn.ninja` link building (a direct
  `playtak.com/games/<id>/ninjaviewer` link, which PlayTak's own server
  redirects into ptn.ninja preloaded with that game's real PTN - no local
  PTN-document building or link-shortening service needed), human-readable
  game results, and board-image rendering (via the `tps-ninja` package,
  which depends on native `canvas` bindings).
- `src/scripts/` — standalone probe scripts used to explore PlayTak's wire
  protocol against live traffic. Not wired into the bot; kept around as
  debugging tools.

## Conventions to follow
- TypeScript, strict mode is on in `tsconfig.json` — don't loosen it.
- One command per file in `src/commands/`, each exporting `data`
  (SlashCommandBuilder) and `execute`. New commands must be registered in
  both `src/index.ts` (the commands Collection) and
  `src/deploy-commands.ts` (the commands array), or they won't show up in
  Discord.
- Discord has no native command-alias support. An alias is a separate
  command file registered under a different name that reuses the primary
  command's `execute` (see `spectate.ts` next to `watch.ts`).
- Discord command descriptions are capped at 100 characters — keep
  `.setDescription(...)` terse; put fuller explanations in `help.ts`.
- Keep secrets out of source. Anything sensitive goes in `.env`, which is
  gitignored and never committed.
- Prefer small, verifiable steps: after any change, run `npm run build` to
  catch type errors before considering a task done.
- Only one PlayTak connection should ever be open (`initPlaytak()`'s
  singleton) — new features should subscribe to it, not open another.
- This bot is currently developed and tested on the user's own
  private/trusted Discord server. It will eventually move to the "Tak Talk"
  Discord server and live there exclusively - don't assume Tak Talk is the
  current target, and give that community a heads-up before pointing a
  persistent connection at PlayTak from there. Testing after that point
  happens via a separate bot instance, not by running the same instance in
  two servers at once.

## Constraints
- Don't commit or print real token/secret values anywhere, including in
  commit messages, logs, or comments.
- Don't register commands globally (omit `DISCORD_GUILD_ID`) unless asked —
  guild-scoped registration is faster for iteration and is what's expected,
  since a bot instance only ever lives in one server.
- Never send anything to PlayTak that creates or affects a game (no seeks,
  no moves, no account actions) — this bot is read-only against PlayTak by
  design, which matters both technically and for staying a good citizen of
  a small community's server.

## What's next
Take direction from the human on which feature to build next — don't
invent new bot features unprompted. Known open items:
1. Continue testing `/watch`, `/list`, `/seeks`, and `/announce` on the
   private test server.
2. When ready, bring the bot to the Tak Talk Discord server.
3. Test `/expand here`/`/expand new` and the new catch-up behavior (inline
   boards for small reconnect gaps, chunked summaries otherwise) on the
   private test server.
