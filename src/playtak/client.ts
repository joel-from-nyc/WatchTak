import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { parseLine, PlaytakEvent } from './protocol';

const PLAYTAK_WS_URL = 'wss://playtak.com/ws';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

// A connection that has received nothing for this long is treated as
// half-open and terminated, which triggers a reconnect. A silently dropped
// TCP connection never fires 'close' on its own. Set well above
// PING_INTERVAL_MS (every PING gets an "OK" back).
const STALE_CONNECTION_MS = 75_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;

// Diagnostic only: logs a warning when events arrive faster than this. A
// history replay on Observe or a seek replay on reconnect can legitimately
// trigger it.
const EVENT_RATE_WINDOW_MS = 1_000;
const EVENT_RATE_WARN_THRESHOLD = 50;
const EVENT_RATE_WARN_COOLDOWN_MS = 30_000;

export interface PlaytakClient {
  on(event: 'event', listener: (event: PlaytakEvent) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

// Guest, read-only connection to PlayTak. Emits every parsed server line as
// an 'event'. Never sends anything that creates, joins, or affects a game.
export class PlaytakClient extends EventEmitter {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private recentEventTimestamps: number[] = [];
  private lastRateWarningAt = 0;
  private lastMessageAt = 0;

  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  // For Observe/Unobserve only.
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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

  // `ws` is compared against `this.ws` so a check queued just before a
  // reconnect cannot terminate the new socket.
  private checkStaleConnection(ws: WebSocket): void {
    if (this.ws !== ws) return;
    if (Date.now() - this.lastMessageAt < STALE_CONNECTION_MS) return;
    console.warn(
      `No data from PlayTak in over ${STALE_CONNECTION_MS}ms - connection is likely half-open. Forcing a reconnect.`,
    );
    ws.terminate();
  }

  private openSocket(): void {
    const ws = new WebSocket(PLAYTAK_WS_URL, 'binary');
    this.ws = ws;

    ws.on('open', () => {
      // `Protocol 2` is only accepted before login. It adds a bot flag to
      // seek lines and switches clock updates to milliseconds. Sent on every
      // open so reconnects do not fall back to v1.
      ws.send('Protocol 2');
      ws.send('Login Guest');
      this.lastMessageAt = Date.now();
      this.pingTimer = setInterval(() => ws.send('PING'), PING_INTERVAL_MS);
      this.heartbeatTimer = setInterval(() => this.checkStaleConnection(ws), HEARTBEAT_CHECK_INTERVAL_MS);
      this.emit('connected');
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      for (const line of data.toString().split('\n')) {
        if (line.length > 0) {
          this.trackEventRate();
          this.emit('event', parseLine(line));
        }
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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
