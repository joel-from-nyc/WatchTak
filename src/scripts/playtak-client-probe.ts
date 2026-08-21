// Smoke test for PlaytakClient: connect, log every typed event, confirm
// nothing falls through to 'unknown' unexpectedly. Not wired into the bot.
//
// Run with: npx ts-node src/scripts/playtak-client-probe.ts

import { PlaytakClient } from '../playtak/client';

const client = new PlaytakClient();

client.on('connected', () => console.log('[connected]'));
client.on('disconnected', () => console.log('[disconnected]'));
client.on('event', (event) => {
  console.log(JSON.stringify(event));
});

client.connect();

process.on('SIGINT', () => {
  client.disconnect();
  process.exit(0);
});
