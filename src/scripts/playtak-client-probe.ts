// Connects with PlaytakClient and logs every parsed event, to check that
// nothing falls through to 'unknown'. Not used by the bot.
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
