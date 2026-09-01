import fs from 'fs';
import path from 'path';

// Persists which channels have /showbots turned off, so the preference
// survives a restart and (unlike /announce's mode) applies even in a channel
// where /announce hasn't been turned on yet. A plain JSON file mirrors
// announceStore.ts's approach - a handful of channel ids doesn't need a
// database. Only channels with bots hidden are stored; an absent entry means
// "on" (the default - bots shown, same as before this feature existed).
//
// __dirname is src/playtak (ts-node) or dist/playtak (compiled) - either way,
// two levels up is the project root. Namespaced by DISCORD_GUILD_ID for the
// same reason as announceStore.ts's getStorePath() - see its comment.
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

// Read once and kept in memory: getShowBots() is consulted for every
// announcing channel on every game-started event, and this process is the only
// thing that ever writes the file, so re-reading it from disk each time would
// be pure overhead.
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
