import fs from 'fs';
import path from 'path';

// Persists which channels have /showbots off. An absent entry means on.

// Same location and guild namespacing as announceStore.ts.
function getStorePath(): string {
  const guildId = process.env.DISCORD_GUILD_ID;
  const filename = guildId ? `showbots-state.${guildId}.json` : 'showbots-state.json';
  return path.join(__dirname, '..', '..', 'data', filename);
}

interface ShowBotsState {
  [channelId: string]: boolean;
}

function readState(): ShowBotsState {
  try {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state: ShowBotsState): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
}

// Cached in memory; this process is the only writer.
let cached: ShowBotsState | undefined;

function state(): ShowBotsState {
  if (!cached) cached = readState();
  return cached;
}

export function getShowBots(channelId: string): boolean {
  return state()[channelId] ?? true;
}

export function setShowBots(channelId: string, show: boolean): void {
  const current = state();
  if (show) {
    delete current[channelId];
  } else {
    current[channelId] = false;
  }
  writeState(current);
}
