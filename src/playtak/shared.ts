import { PlaytakClient } from './client';
import { GameRegistry } from './registry';
import { SeekRegistry } from './seekRegistry';

// A single shared guest connection for the whole bot. PlayTak's guest login
// is meant for humans, so every feature (/seeks, /list, /watch) reuses this
// one connection rather than opening its own.
let client: PlaytakClient | undefined;
let gameRegistry: GameRegistry | undefined;
let seekRegistry: SeekRegistry | undefined;

export function initPlaytak(): { client: PlaytakClient; gameRegistry: GameRegistry; seekRegistry: SeekRegistry } {
  if (!client) {
    client = new PlaytakClient();
    gameRegistry = new GameRegistry(client);
    seekRegistry = new SeekRegistry(client);
    client.on('error', (err) => console.error('PlayTak connection error:', err));
    client.connect();
  }
  return { client, gameRegistry: gameRegistry!, seekRegistry: seekRegistry! };
}

export function getPlaytakClient(): PlaytakClient {
  if (!client) throw new Error('PlayTak client not initialized - call initPlaytak() first');
  return client;
}

export function getGameRegistry(): GameRegistry {
  if (!gameRegistry) throw new Error('PlayTak client not initialized - call initPlaytak() first');
  return gameRegistry;
}

export function getSeekRegistry(): SeekRegistry {
  if (!seekRegistry) throw new Error('PlayTak client not initialized - call initPlaytak() first');
  return seekRegistry;
}
