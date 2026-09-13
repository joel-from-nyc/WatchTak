# Architecture

WatchTak is a single Node process that holds one connection to PlayTak and
one to Discord, and translates between them. This document is the map of how
that works. For what the bot does and how to run it, see the [README](../README.md).

## The PlayTak side

**One connection.** `src/playtak/client.ts` opens a guest WebSocket to
`wss://playtak.com/ws` and emits every parsed server line as an `event`.
`shared.ts` creates it once (`initPlaytak()`) along with the two registries
below, and exposes getters. Every feature subscribes to that one client;
nothing opens a second connection. The client sends only `Protocol 2`,
`Login Guest`, `PING`, `Observe`, and `Unobserve`. It never creates or affects
a game.

**Protocol.** `protocol.ts` parses PlayTak's line protocol into typed events.
Field orders follow the server source (`USTakAssociation/playtak-api`). The
bot sends `Protocol 2` before login; v2 adds a bot flag to seek lines,
reports an open seek's opponent as `"0"` (normalized to `''`), and sends clock
updates as `Game#<no> Timems` in milliseconds instead of `Time` in seconds.
The parser accepts both versions. Wire komi is in half-points (4 means 2).

**Reconnects.** A dropped connection is reconnected automatically, and a
half-open connection (no data for 75s) is terminated so that happens. On
every (re)connect PlayTak replays the full active game list and open seek
list, and never sends removals for anything that ended while the bot was
disconnected. `registry.ts` and `seekRegistry.ts` (in-memory views of active
games and open seeks) therefore reconcile against the replay about two
seconds after connect, dropping anything that did not come back.

**Ratings.** The wire protocol carries no ratings. `ratings.ts` polls
`https://playtak.com/ratinglist.json` every 20 minutes. A rating of 0 means
unrated. The list's bot flag supplements bot detection from seek lines,
catching bots that only ever accept seeks.

**Archive.** `gameArchive.ts` fetches finished games from
`https://api.playtak.com/v1/games-history/:id`, for Review threads and for
`/expand` on a finished game. Move tokens use the live wire format.

## Watching a game

`watcher.ts` owns a watched game's Discord thread. On `Observe`, PlayTak
replays the game's full history using the same message shapes as live moves;
the watcher buffers moves until none has arrived for 500ms, then posts
according to how the thread started:

- A new thread gets the history as chunk summaries plus the current board.
- A thread that already shows some moves (after a reconnect or restart) gets
  only what it is missing: drawn inline for gaps of up to 10 plies, chunked
  otherwise.

Events are handled strictly one at a time through a promise chain, so two
events for the same game never mutate the same state concurrently.

Three helpers hang off the watcher:

- `lowTime.ts`: the low-time countdown. PlayTak sends clock updates only at
  move boundaries, so the moment a player crosses 60 seconds is computed
  from their clock at turn start. The warning is a `<t:...:R>` countdown
  that ticks client-side, edited to static text once a move, undo, or game
  end resolves it.
- `threadClose.ts`: the close lifecycle. A finished game's thread carries one
  marker message, either the pending warning (with its deadline) or the
  "was archived on" record it is rewritten into. The thread closes 24h after
  its last message or the shown deadline, whichever is later. The close
  timer and the sweep both read the marker and make the same decision, so
  the behavior survives a restart.
- `threadLookup.ts`: finding a game's thread and reading back what it shows.
  Thread names end in `(#<gameNo>)`, and move posts start with
  `Move: <number><W|B>`, so a restarted process can recover everything it
  needs from Discord alone.

**Sweep.** Every 15 minutes the watcher reconciles every open bot thread
against the registry: a live game not being watched is resumed; a finished
game's thread gets a close warning or is closed if due.

**Catch-up summaries.** `catchup.ts` defines the "Moves 3W-7B" chunk
messages of at most 10 plies. Ten is Discord's per-message attachment cap,
and a bot may edit its own old messages, so `/expand here` can later attach
one board per ply to each chunk in place. `/expand new` instead builds a
separate replay thread with one message per move and attaches it as a live
mirror of the watch.

## Announcing

`announcer.ts` runs `/announce`: it posts each open human seek to the channel
and deletes the post when the seek is taken or cancelled, so the channel
shows only what is joinable. `seekToGame.ts` turns a taken seek into a
game-started notice. The protocol carries no link between a seek and the
game it becomes, so a removed seek and a new game naming the same player
within 5 seconds are treated as the same event, in either order. The notice
carries a Watch button, swapped for a Review button when the game ends.

Which games get a notice is decided per channel by `modeAllowsGame()` in
`announcer.ts`, from the `/announce` mode, `/showbots`, and any `/rating`
rule. Those settings persist through `jsonStore.ts`: one JSON file per
setting in `data/` (or `DATA_DIR`), namespaced by `DISCORD_GUILD_ID`,
cached in memory, written atomically.

## Cleanup

`pruneRules.ts` holds the scanning and deletion primitives shared by the
manual `/prune` command and the silent `autoPrune.ts` sweep. Deletion goes
through `bulkDelete`, falling back to one-at-a-time for messages over two
weeks old (Discord refuses to bulk-delete those) or when the bot lacks
Manage Messages. Every scan is page-capped, and a scan that could not cover
everything is never trusted to say a thread is absent.

## Rendering

`boardImage.ts` renders boards with `tps-ninja`, which depends on the native
`canvas` package. Rendering is synchronous. The Roboto font is used when
installed on the host; canvas falls back to its default otherwise.

## Tests

The pure modules (`protocol.ts`, `ptn.ts`, `format.ts`, `catchup.ts`,
`result.ts`, `jsonStore.ts`) have `*.test.ts` files beside them, run with
`node:test` through ts-node. Modules that talk to Discord or PlayTak are not
unit-tested.
