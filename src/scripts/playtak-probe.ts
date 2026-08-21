// Throwaway probe: connect to PlayTak as a guest and log every raw line the
// server sends, so we can design the real protocol parser against actual
// traffic instead of guessing from docs. Not wired into the bot.
//
// Run with: npx ts-node src/scripts/playtak-probe.ts

import WebSocket from 'ws';

const PLAYTAK_WS_URL = 'wss://playtak.com/ws';
const PING_INTERVAL_MS = 30_000;

const ws = new WebSocket(PLAYTAK_WS_URL, 'binary');
let pingTimer: NodeJS.Timeout | undefined;

ws.on('open', () => {
  console.log('[connected] sending guest login');
  ws.send('Login Guest');

  pingTimer = setInterval(() => {
    console.log('[send] PING');
    ws.send('PING');
  }, PING_INTERVAL_MS);
});

ws.on('message', (data) => {
  const text = data.toString();
  for (const line of text.split('\n')) {
    if (line.length > 0) {
      console.log('[recv]', JSON.stringify(line));
    }
  }
});

ws.on('close', (code, reason) => {
  console.log(`[closed] code=${code} reason=${JSON.stringify(reason.toString())}`);
  if (pingTimer) clearInterval(pingTimer);
});

ws.on('error', (err) => {
  console.error('[error]', err);
});

process.on('SIGINT', () => {
  console.log('\n[shutting down]');
  ws.close();
  process.exit(0);
});
