import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { parseLine, PlaytakEvent } from './protocol';

const PLAYTAK_WS_URL = 'wss://playtak.com/ws';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

// How long without receiving anything (our own PING gets an "OK" back, and
// the server sends unprompted lines too) before the connection is declared
// dead. A TCP connection that drops silently - no FIN, no RST, e.g. a NAT
// or proxy that just stops forwarding packets - leaves the socket sitting in
// readyState OPEN forever: `ws.send()` doesn't throw for it, and 'close'
// never fires on its own, so without this watchdog the bot can sit unable to
// see new games or seeks for as long as the OS takes to notice (which can be
// hours), even though nothing else looks wrong. Comfortably above
// PING_INTERVAL_MS so one slow round trip doesn't trigger a false positive.
const STALE_CONNECTION_MS = 75_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;

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

  // Forces a reconnect when nothing has arrived in STALE_CONNECTION_MS - see
  // that constant for why a half-open TCP connection needs this rather than
  // just waiting on 'close'. `ws` is the socket this timer was started for,
  // checked against `this.ws` so a check queued just before a reconnect
  // can't terminate the *new* socket.
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
      // Must come before Login Guest - the server only accepts `Protocol`
      // while the connection has no player attached (Client.java gates it
      // on `player == null`). v2 adds a trailing bot flag to Seek lines,
      // which /announce needs to tell human seeks from bot seeks. Sent on
      // every open, not just the first, so reconnects don't silently fall
      // back to v1.
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
