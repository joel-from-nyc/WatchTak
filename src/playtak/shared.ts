import { PlaytakClient } from './client';
import { GameRegistry } from './registry';
import { SeekRegistry } from './seekRegistry';

// The single PlayTak connection and its registries, shared by every feature.
let client: PlaytakClient | undefined;
let gameRegistry: GameRegistry | undefined;
let seekRegistry: SeekRegistry | undefined;

export function initPlaytak(): { client: PlaytakClient; gameRegistry: GameRegistry; seekRegistry: SeekRegistry } {
  if (!client) {
    client = new PlaytakClient();
    gameRegistry = new GameRegistry(client);
    seekRegistry = new SeekRegistry(client);
    client.on('error', (err) => console.error('PlayTak connection error:', err));
    client.on('connected', () => console.log('Connected to PlayTak.'));
    client.on('disconnected', () => console.log('Disconnected from PlayTak, reconnecting...'));
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
