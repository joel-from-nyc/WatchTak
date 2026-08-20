# Discord Bot Proof of Concept

A TypeScript Discord bot (discord.js) with two commands and a small webhook
server, showing both directions of interop with an external website:

- **Discord → Website**: `/launch` starts a "game session" and returns a join link
  (currently faked locally — swap in a real `fetch` call to your site's API).
- **Website → Discord**: a webhook endpoint (`POST /events/session-update`) lets
  your website push updates back into the Discord channel that started the session.

## Setup

1. **Create the Discord application**
   - Go to https://discord.com/developers/applications → New Application.
   - Under "Bot", click "Reset Token" and copy it — this is `DISCORD_TOKEN`.
   - Copy the "Application ID" from General Information — this is `DISCORD_CLIENT_ID`.
   - Under "Bot", enable the intents you need (none required beyond default for this POC).

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. For fast local testing, also
   set `DISCORD_GUILD_ID` to your test server's ID (right-click the server icon
   with Developer Mode on in Discord settings → Advanced).

4. **Invite the bot to your server**
   Build an invite URL in the Developer Portal under OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Read Message History` (add more as needed)
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
   You should see `Logged in as YourBot#1234` and `Webhook server listening on port 3000`.

7. **Try it**
   - In Discord, run `/ping` and `/launch`.
   - `/launch` will print a fake join URL and a session ID.
   - Simulate your website calling back in with an update:
     ```bash
     curl -X POST http://localhost:3000/events/session-update \
       -H "Content-Type: application/json" \
       -H "x-webhook-secret: change-me-to-something-random" \
       -d '{"sessionId": "PASTE_SESSION_ID_HERE", "message": "A second player joined!"}'
     ```
     That message should appear in the Discord channel where you ran `/launch`.

## Project structure

```
src/
  index.ts           # Bot entry point: logs in, wires up commands, starts webhook server
  server.ts          # Express server for website -> Discord updates
  sessionStore.ts     # In-memory map of game session ID -> Discord channel
  deploy-commands.ts  # One-off script to register slash commands with Discord
  commands/
    ping.ts           # Basic health-check command
    launch.ts          # Starts a session and returns a join link
```

## Where to go from here

- **Real website integration**: replace the fake session creation in `launch.ts`
  with an actual `fetch` call to your site's API, and have your site call the
  webhook endpoint in `server.ts` for real events (player joined, game ended, etc.).
- **Persistence**: swap `sessionStore.ts`'s in-memory `Map` for Redis or a database
  so sessions survive a bot restart and work across multiple bot instances.
- **Webhook security**: the shared-secret header is fine for a proof of concept;
  for production consider HMAC-signed payloads (like Stripe/GitHub webhooks).
- **Deployment**: once it works locally, host it on a small VPS, Railway, or Fly.io
  so it stays online. If your website and bot are hosted separately, make sure
  the webhook URL is reachable from your website's server (not `localhost`).
- **More commands**: add new files in `src/commands/`, import and register them
  in both `index.ts` and `deploy-commands.ts`.
