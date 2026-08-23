import fs from 'fs';
import path from 'path';

// Persists which channels have /announce toggled on, and the id of the
// "now on" confirmation message posted there, so a restart can resume
// announcing there and clean up that now-stale confirmation - see
// announcer.ts. A plain JSON file is enough for a handful of channel ids;
// no database needed for this.
//
// __dirname is src/playtak (ts-node) or dist/playtak (compiled) - either
// way, two levels up is the project root.
//
// Namespaced by DISCORD_GUILD_ID so more than one bot instance (e.g. a
// production and a testing instance, both built from the same dist/ - see
// index.ts's env-file argument) can run side by side without both
// instances reading and clobbering the same file. Computed lazily inside
// getStorePath() rather than as a module-level const, since index.ts loads
// its env file (dotenv.config()) *after* this module is first required -
// reading process.env.DISCORD_GUILD_ID at import time would always see it
// as unset.
function getStorePath(): string {
  const guildId = process.env.DISCORD_GUILD_ID;
  const filename = guildId ? `announce-state.${guildId}.json` : 'announce-state.json';
  return path.join(__dirname, '..', '..', 'data', filename);
}

interface AnnounceState {
  [channelId: string]: { confirmationMessageId: string };
}

function readState(): AnnounceState {
  try {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state: AnnounceState): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
}

export function loadAnnounceState(): AnnounceState {
  return readState();
}

export function setChannelAnnouncing(channelId: string, confirmationMessageId: string): void {
  const state = readState();
  state[channelId] = { confirmationMessageId };
  writeState(state);
}

export function clearChannelAnnouncing(channelId: string): void {
  const state = readState();
  delete state[channelId];
  writeState(state);
}
