import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { parseLine, PlaytakEvent } from './protocol';

const PLAYTAK_WS_URL = 'wss://playtak.com/ws';
const PING_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

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

  private openSocket(): void {
    const ws = new WebSocket(PLAYTAK_WS_URL, 'binary');
    this.ws = ws;

    ws.on('open', () => {
      ws.send('Login Guest');
      this.pingTimer = setInterval(() => ws.send('PING'), PING_INTERVAL_MS);
      this.emit('connected');
    });

    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.length > 0) {
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
