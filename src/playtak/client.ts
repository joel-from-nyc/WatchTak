import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { parseLine, PlaytakEvent } from './protocol';

const PLAYTAK_WS_URL = 'wss://playtak.com/ws';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

// Diagnostic only - flags when events are arriving faster than the bot can
// plausibly be keeping up with (e.g. board rendering is synchronous and
// scales with game length, so several fast games at once can make the event
// loop fall behind). A legitimate burst - PlayTak replaying a game's full
// history on Observe, or every open seek on reconnect - can also cross this
// threshold; that's expected and not itself a bug, so this only logs a
// warning rather than dropping or throttling anything. Cooldown keeps a
// sustained flood from spamming the log once per event.
const EVENT_RATE_WINDOW_MS = 1_000;
const EVENT_RATE_WARN_THRESHOLD = 50;
const EVENT_RATE_WARN_COOLDOWN_MS = 30_000;

export interface PlaytakClient {
  on(event: 'event', listener: (event: PlaytakEvent) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

// Guest-only, read-only client: logs in as a guest and emits every parsed
// server event. Never sends anything that would create/join/affect a game.
export class PlaytakClient extends EventEmitter {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private recentEventTimestamps: number[] = [];
  private lastRateWarningAt = 0;

  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  // For read-only spectate commands only (Observe/Unobserve/GameList/List) -
  // this client never sends anything that creates, joins, or affects a game.
  send(line: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(line);
    } else {
      console.warn(`Dropped PlayTak command, connection not open: ${line}`);
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private trackEventRate(): void {
    const now = Date.now();
    this.recentEventTimestamps.push(now);
    const cutoff = now - EVENT_RATE_WINDOW_MS;
    while (this.recentEventTimestamps.length > 0 && this.recentEventTimestamps[0] < cutoff) {
      this.recentEventTimestamps.shift();
    }
    if (
      this.recentEventTimestamps.length > EVENT_RATE_WARN_THRESHOLD &&
      now - this.lastRateWarningAt > EVENT_RATE_WARN_COOLDOWN_MS
    ) {
      this.lastRateWarningAt = now;
      console.warn(
        `PlayTak events arriving fast (${this.recentEventTimestamps.length} in the last ` +
          `${EVENT_RATE_WINDOW_MS}ms) - handlers may be falling behind and producing errors ` +
          'or delayed posts. This can be a normal replay burst (Observe/reconnect) rather ' +
          'than a real problem.',
      );
    }
  }

  private openSocket(): void {
    const ws = new WebSocket(PLAYTAK_WS_URL, 'binary');
    this.ws = ws;

    ws.on('open', () => {
      // Must come before Login Guest - the server only accepts `Protocol`
      // while the connection has no player attached (Client.java gates it
      // on `player == null`). v2 adds a trailing bot flag to Seek lines,
      // which /announce needs to tell human seeks from bot seeks. Sent on
      // every open, not just the first, so reconnects don't silently fall
      // back to v1.
      ws.send('Protocol 2');
      ws.send('Login Guest');
      this.pingTimer = setInterval(() => ws.send('PING'), PING_INTERVAL_MS);
      this.emit('connected');
    });

    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.length > 0) {
          this.trackEventRate();
          this.emit('event', parseLine(line));
        }
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.emit('disconnected');
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });
  }
}
