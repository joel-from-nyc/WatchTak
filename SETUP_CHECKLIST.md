# Manual Setup Checklist (do this before running Claude Code)

These steps involve real credentials, so it's worth doing them yourself —
Claude Code should never see or generate your actual token/secret values.

- [ ] Go to https://discord.com/developers/applications → New Application
- [ ] Under "Bot", click "Reset Token" and copy it
- [ ] Copy the "Application ID" from the General Information page
- [ ] Under "Bot", make sure "Public Bot" is off if you don't want strangers
      adding it to their own servers (optional, up to you)
- [ ] In Discord, enable Developer Mode (User Settings → Advanced), then
      right-click your test server's icon → "Copy Server ID"
- [ ] In OAuth2 → URL Generator: check `bot` and `applications.commands`
      scopes, and under bot permissions check at least "Send Messages" and
      "Read Message History". Open the generated URL and add the bot to
      your test server.
- [ ] Copy `.env.example` to `.env` and fill in:
      - `DISCORD_TOKEN`
      - `DISCORD_CLIENT_ID`
      - `DISCORD_GUILD_ID` (your test server ID, for instant command updates)
      - `WEBHOOK_SECRET` (make up any random string)

Once `.env` is filled in, you're ready to hand this off to Claude Code —
it'll pick up context from `CLAUDE.md` automatically.

## Suggested first prompt for Claude Code

```
Get this Discord bot proof of concept running: install dependencies,
verify it builds with no type errors, register the slash commands, and
start the bot. Confirm /ping and /launch work in Discord, then set up
.gitignore and git if it isn't already. Read CLAUDE.md first for context.
```
