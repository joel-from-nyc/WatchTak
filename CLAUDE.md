# Project: NokBot — Tak/PlayTak Discord companion bot

## What this is
A Discord bot (TypeScript, discord.js v14) built around the abstract board
game Tak and the PlayTak.com community. It maintains a single read-only
guest connection to PlayTak and bridges it into Discord: browsing open
seeks and in-progress games, and watching a specific game live in a
dedicated thread as it's played, with board images and PTN notation.

This started as a generic "launch a session on an external website" proof
of concept. That direction was abandoned in favor of the PlayTak
integration - the old `/launch` command, its webhook server, and its
in-memory session store have been removed. `/ping` is the only piece that
survived from the original scaffold.

## Current state
Slash commands (registered guild-scoped for near-instant updates - each
bot instance only ever lives in one Discord server; testing happens on a
separate instance, not a second server on the same process):
- `/ping` — health check.
- `/list` (alias `/l`) — lists PlayTak games currently in progress.
- `/watch <game>` (alias `/w`) — watches a live PlayTak game: opens (or
  reuses) a Discord thread, posts the board plus each move in PTN notation
  as it happens, and on game end announces the winner with a `ptn.ninja`
  link to the full game before archiving the thread 24 hours later.
  `<game>` accepts a game ID or a partial player name (ambiguous matches
  ask the user to be more specific); with no argument it behaves like
  `/list`.
- `/seeks` (aliases `/s`, `/seek`) — lists currently open public seeks
  (private challenges aimed at one specific opponent are excluded, since
  no one else can accept them).
- `/help` — full explanation of every command and its aliases (Discord
  caps a command's own description at 100 characters, so this is the
  fuller version).

## Architecture
- `src/playtak/client.ts` — the single guest WebSocket connection to
  `wss://playtak.com/ws`, shared by the whole bot via `shared.ts`'s
  singleton (`initPlaytak()`). It only ever sends `Login Guest`, the
  keepalive `PING`, and per-watch `Observe`/`Unobserve` - never anything
  that creates or affects a game.
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
  replaces a persisted store.
- `src/playtak/ptn.ts`, `ptnLink.ts`, `result.ts`, `boardImage.ts` — PTN
  notation conversion, `ptn.ninja` link building (with link shortening),
  human-readable game results, and board-image rendering (via the
  `tps-ninja` package, which depends on native `canvas` bindings).
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
  command's `execute` (see `s.ts`/`seek.ts` next to `seeks.ts`, or
  `l.ts`/`w.ts` next to `list.ts`/`watch.ts`).
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
- Eventual hosting target is the user's Dreamhost shell space; for now it
  just runs locally via `npm run dev`.

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
1. Continue testing `/watch`, `/list`, and `/seeks` on the private test
   server.
2. When ready, bring the bot to the Tak Talk Discord server.
3. Eventually deploy to Dreamhost shell hosting instead of running locally.
