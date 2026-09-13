# WatchTak

A Discord bot (TypeScript, discord.js v14) that follows Tak games on
PlayTak.com. Read [README.md](README.md) for what it does and how to run it,
and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the modules fit
together. This file is only what an agent needs to change the code safely.

## Conventions

- Run `npm run check` (Prettier, build, tests) after any change. Strict
  TypeScript is on; don't loosen it.
- `shared.ts` owns the PlayTak singletons (connection, game registry, seek
  registry); modules read them through its getters. The Discord client is
  created in `index.ts` and passed to the `register*()` functions.
- One command per file in `src/commands/`, exporting `data` and `execute`
  (and `autocomplete` where an option autocompletes). Add new commands to
  the list in `src/commands/index.ts`; that both routes and registers them.
- Aliases are separate command files reusing the primary's `execute`
  (`spectate.ts`). Autocomplete must be declared on each registration.
- Command descriptions are capped at 100 characters by Discord. Keep them
  terse; `help.ts` carries the fuller text, one line per command.
- Commands whose output is a point-in-time statement reply ephemerally.
  The only public replies are `/announce`'s "now on" banner and `/watch`'s
  thread link.
- Timestamps use Discord `<t:...>` tags (viewer-local time). They don't
  render inside code blocks, so they go outside the fence.
- Comments describe what the code does and any non-obvious fact it relies
  on. No design rationale or history.
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
