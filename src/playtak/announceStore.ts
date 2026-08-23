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
  [channelId: string]: { confirmationMessageId: string; quiet?: boolean };
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

export function setChannelAnnouncing(channelId: string, confirmationMessageId: string, quiet = false): void {
  const state = readState();
  state[channelId] = { confirmationMessageId, quiet };
  writeState(state);
}

export function clearChannelAnnouncing(channelId: string): void {
  const state = readState();
  delete state[channelId];
  writeState(state);
}

// Flips the quiet flag on an already-announcing channel in place, leaving
// its confirmation-message id untouched - used when /announce toggles
// between "on" and "quiet" without a full off/on cycle (see announce.ts).
// A no-op if the channel isn't in the persisted state at all (shouldn't
// happen in practice - the caller only calls this on a channel it already
// knows is announcing).
export function setChannelQuiet(channelId: string, quiet: boolean): void {
  const state = readState();
  const entry = state[channelId];
  if (!entry) return;
  entry.quiet = quiet;
  writeState(state);
}
