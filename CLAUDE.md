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
  it behaves like `/list`. The `game` option autocompletes from the live
  registry as you type (`watch.ts`'s `autocomplete()`, routed by
  `index.ts`'s `isAutocomplete()` branch): each row shows both players
  with ratings plus board size and time control, and the value submitted
  is the game number, so picking from the dropdown always takes the
  unambiguous path. `/spectate` declares the same option - autocomplete
  is per-registration, not inherited from the shared `execute`.
- `/expand here|new` — run inside a game thread. Catch-up summaries
  (posted when a thread starts mid-game, or after a reconnect gap of more
  than 10 plies) are "Moves 3W-7B" chunk messages of ≤10 plies each, sized
  to Discord's 10-attachments-per-message cap. `here` edits each unfilled
  summary in place, attaching one board PNG per ply as a plain gallery (a
  takeback that rewrote a summarized move marks that summary stale instead
  of drawing wrong boards). `new` builds a separate "Replay: ... - game N"
  thread with one message+board per ply, then attaches it as a live mirror
  of the watch so both threads get subsequent moves (mirror is in-memory
  only: a restart orphans the replay thread; its name deliberately doesn't
  match the watcher's `(#N)` thread-name pattern so the sweep never adopts
  it, and the pruners remove it once it's a day old with no human chat,
  like any other thread - `catchup.ts` owns the name format so both sides
  agree on it). Games over 150 plies
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
  each one first, since it's stale the instant the bot goes down. That
  "now on" confirmation is the only public reply `/announce` makes -
  status checks, "already on/off", mode switches, and "now off" are all
  ephemeral, since they're point-in-time statements that would otherwise
  pile up in the channel.
- `/showbots <on|off>` — per-channel, persisted independently of
  `/announce` (`showBotsStore.ts`) so it survives that being off. When
  off, any game with a confirmed bot on either side is dropped from
  game-started notices. Bot *seeks* were already never announced, so
  this only affects game notices. Replies privately.
- `/rating human:<n> bot:<n>` — a standing per-channel filter
  (`ratingStore.ts`): when set, it's the authoritative gate for game
  notices — only games featuring a registered human rated at least
  `human` versus another human (any rating) or versus a bot rated at
  least `bot` are shown; everything else is hidden. That both beats
  `/showbots` (a qualifying bot game shows even with it off) and makes
  `/showbots`, `noguest`, and `users` moot in that channel. It
  deliberately does *not* beat `quiet`, which means "no game notices here
  at all". Unknown ratings fail the bounds (hide), including the
  first-minute window after a restart before the ratings list loads.
  `/rating off` clears it. Replies privately.
- `/prune duplicates|threads|messages` — manual, on-demand cleanup of a
  channel's own bot messages/threads. `duplicates` collapses repeat watch
  threads for the same game down to one, skipping (and reporting) any set
  with human chat in it. `threads` removes watch threads that no longer
  match the channel's current `/announce`/`/showbots`/`/rating` settings,
  plus any over a day old that nobody ever chatted in (`/expand new`
  replay threads included). `messages` removes
  channel messages that no longer match those settings, game notices and
  Discord's own "started a thread" lines whose thread is gone (also a day
  old), any public reply from a command that now replies privately
  (identified by the command name Discord records on every slash-command
  reply — `message.interaction.commandName` — against the
  `NOW_EPHEMERAL_COMMANDS` set in `prune.ts`), every `/announce` reply
  except the channel's tracked "now on" banner, and `/watch`'s public
  "Spectate: <#thread>" links once their thread is gone (they render as
  "#unknown" by then). Live games are never touched.
  Requires Manage Channels; refuses to run until PlayTak's rating list has
  loaded at least once since the last restart, since a `/rating` rule
  can't be checked before then and deletion isn't reversible. Replies
  privately, including its progress heartbeat on a long run.
- Stale notices and threads are also cleaned up **automatically and
  silently**, independent of `/prune` above (`playtak/autoPrune.ts`, no
  slash command of its own): roughly every 30 minutes, in every channel
  that's ever had `/announce` configured, a game-started/finished notice
  over a day old is removed if its thread no longer exists, or removed
  along with its thread if that thread exists but no human ever posted in
  it. Unlike `/prune`, this never re-checks a notice against the
  channel's *current* settings and never posts anything about what it
  did — it only ever removes things nobody engaged with, without adding
  any channel noise of its own. Two details both pruners share
  (`pruneRules.ts`): a notice from before the game number was part of the
  text is identified by its Watch/Review button's customId instead, and
  Discord's "started a thread" system line — whose message id *is* the
  thread's id, and which Discord does not remove when the thread is
  deleted — is removed along with any thread the pruners delete, and
  cleaned up on its own whenever its thread is found to be gone. Replay
  threads (`/expand new`), which have no notice of their own, get the same
  game-over/day-old/no-chat rule applied directly, since a restart severs
  the watcher's link to one and nothing else would ever close it.
- `/help` — full explanation of every command and its aliases (Discord
  caps a command's own description at 100 characters, so this is the
  fuller version). Keep the per-command lines here terse.
- The bot's Discord presence shows the live PlayTak game count
  ("Watching 4 games on PlayTak" — `playtak/presence.ts`), read from the
  same registry that backs `/list`. Refreshed on a timer, not per
  GameList event: games start and end constantly and every reconnect
  replays the whole list, which would blow past the gateway's presence
  rate limit.

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
  it's larger - `WatchState.historyMode`'s `'reconnect'` case. A finished
  game's thread gets one "will be archived" warning, then is archived and
  locked once it's been quiet for 24h - 24h after its *most recent
  message*, not after the game ended, so an ongoing discussion keeps
  pushing the close out, and a closed thread a moderator reopens by
  posting in it gets a fresh 24h rather than being shut again on the next
  sweep. The warning message is the durable record: its embedded
  timestamp is the deadline, it's edited in place whenever that moves
  (never re-posted), and it's rewritten to "was archived on" only after
  the archive actually succeeds. `findCloseMarker()`/`closeDueAt()`/
  `reconcileClose()` are the whole mechanism, shared by the in-memory
  close timer and the periodic sweep, so both make the same decision from
  the same record even across a restart.
- `src/playtak/pruneRules.ts` — staleness-scanning primitives (the stale-
  age threshold, "does a real thread exist for this notice's game", "has a
  human ever posted in this thread") shared by the manual `/prune` command
  and the silent automatic sweep below, so the two don't each reimplement
  the same paginated Discord API scanning. Deletions go through
  `deleteMessages()`, which batches up to 100 at a time via `bulkDelete`
  — individual deletion is throttled hard enough to have once left a
  `/prune` run looking hung for minutes. Two cases still fall back to one
  at a time, silently: a message over two weeks old (Discord refuses to
  bulk-delete those at all) and a channel where the bot lacks Manage
  Messages (which bulk deletion requires, but deleting one's own messages
  does not).
- `src/playtak/autoPrune.ts` — the automatic counterpart to `/prune`
  described above: runs on its own timer, scoped to every channel with
  `/announce` ever configured (read from `announceStore.ts`), entirely
  silently.
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
- `assets/watchtak-icon.webp` / `.png` — the bot's Discord profile picture
  (donated by a community member). The `.webp` is the original; the `.png`
  is what actually gets uploaded, since Discord's avatar endpoint accepts
  PNG/JPG/GIF but *not* WebP (discord.js labels the data URI `image/jpg`
  whatever the real bytes are, so Discord sniffs the content and rejects a
  WebP outright). Neither is referenced at runtime.
- `src/scripts/set-avatar.ts` (`npm run set-avatar`) — sets the bot's
  avatar from one of those files via `ClientUser#setAvatar`. Deliberately
  a manual script, never something `index.ts` does on startup: Discord
  rate-limits avatar changes to roughly a couple per hour, and this bot is
  restarted on every deploy.

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
4. Test the corrected thread close/archive behavior (no more archiving a
   game's thread within minutes of it ending, no more repeat "appears to
   have ended" spam) and the new silent automatic prune sweep, both on the
   private test server.
