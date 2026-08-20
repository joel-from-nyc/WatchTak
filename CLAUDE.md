# Project: Discord Bot (proof of concept → real bot)

## What this is
A Discord bot in TypeScript (discord.js v14) that will eventually let users
run commands that either return information or trigger actions. The main
interesting piece: two Discord users should be able to launch a session on
an external website (e.g. a game) via a bot command, and the website should
be able to push updates back into the Discord channel.

## Current state
A proof of concept already exists in this repo:
- `/ping` — trivial health check command
- `/launch` — creates a fake session ID + join URL locally (no real website
  yet) and stores a mapping of sessionId -> Discord channel in
  `src/sessionStore.ts` (in-memory, wiped on restart)
- `src/server.ts` — an Express server the bot runs alongside the Discord
  client. It exposes `POST /events/session-update` so an external website
  can push a message into the channel tied to a session ID. Auth is a
  single shared secret in the `x-webhook-secret` header (fine for now, not
  production-grade).

Read `README.md` for the full setup/run instructions and file layout before
making changes.

## What's already done vs. what's next
Done: project scaffolding, `/ping`, `/launch` (stub), webhook server,
command registration script.

Not done yet — pick these up:
1. Verify `npm install` and `npm run build` succeed cleanly with no type errors.
2. Confirm `.env` exists (the human sets this up — see SETUP_CHECKLIST.md).
   Do not create or guess values for `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   or `WEBHOOK_SECRET`. If `.env` is missing, stop and ask the human to
   complete the manual setup steps first.
3. Run `npm run deploy-commands`, then `npm run dev`, and confirm the bot
   comes online and both commands respond in Discord.
4. Set up `.gitignore` (node_modules, dist, .env) and initialize git if not
   already done.
5. After that, take direction from the human on which real feature to build
   next (e.g. wiring `/launch` to a real website API, adding moderation
   commands, etc.) — don't invent new bot features unprompted.

## Conventions to follow
- TypeScript, strict mode is on in `tsconfig.json` — don't loosen it.
- One command per file in `src/commands/`, each exporting `data`
  (SlashCommandBuilder) and `execute`. New commands must be registered in
  both `src/index.ts` (the commands Collection) and
  `src/deploy-commands.ts` (the commands array), or they won't show up in
  Discord.
- Keep secrets out of source. Anything sensitive goes in `.env`, which is
  gitignored and never committed.
- The in-memory `sessionStore.ts` is a placeholder. If a task involves
  persistence surviving a restart, flag that a real store (Redis/Postgres)
  is needed rather than silently expanding the in-memory Map.
- Prefer small, verifiable steps: after any change, run `npm run build` to
  catch type errors before considering a task done.

## Constraints
- Don't commit or print real token/secret values anywhere, including in
  commit messages, logs, or comments.
- Don't register commands globally (omit `DISCORD_GUILD_ID`) unless asked —
  guild-scoped registration is faster for iteration and is what's expected
  during this development phase.
