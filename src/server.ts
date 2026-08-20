import express from 'express';
import { Client, TextChannel } from 'discord.js';
import { getSession } from './sessionStore';

// This is the "website -> Discord" half of the interop story. Your game
// website calls this server's endpoints to tell the bot what happened, and
// the bot posts an update in the right Discord channel.
export function startWebhookServer(client: Client, port: number, secret: string) {
  const app = express();
  app.use(express.json());

  // Simple shared-secret check so random people on the internet can't spam
  // your Discord server. For production, prefer a signed-payload scheme
  // (e.g. HMAC signatures, like Stripe/GitHub webhooks use) over a raw
  // shared secret in a header.
  app.use((req, res, next) => {
    if (req.header('x-webhook-secret') !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  // Example: POST /events/session-update
  // body: { sessionId: string, message: string }
  //
  // Your website would call this whenever something worth announcing
  // happens: a player joins, the game starts, someone wins, etc.
  app.post('/events/session-update', async (req, res) => {
    const { sessionId, message } = req.body ?? {};

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    const session = getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'unknown sessionId' });
    }

    try {
      const channel = await client.channels.fetch(session.channelId);
      if (channel instanceof TextChannel) {
        await channel.send(message);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('Failed to post update to Discord:', err);
      res.status(500).json({ error: 'failed to post message' });
    }
  });

  app.listen(port, () => {
    console.log(`Webhook server listening on port ${port}`);
  });
}
