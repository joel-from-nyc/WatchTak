import fs from 'fs';
import path from 'path';

// Persists which channels have /announce toggled on, the id of the "now on"
// confirmation message posted there, and which mode it's in, so a restart
// can resume announcing there and clean up that now-stale confirmation -
// see announcer.ts. A plain JSON file is enough for a handful of channel
// ids; no database needed for this.
//
// `on` shows every game-started notice, `quiet` shows none, and
// `noguest`/`users` are narrower filters on which games get one - see
// announcer.ts's `modeAllowsGame()` for what each one actually checks.
export type AnnounceMode = 'on' | 'quiet' | 'noguest' | 'users';

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

interface StoredChannelState {
  confirmationMessageId: string;
  mode?: AnnounceMode;
  // Legacy field from before `mode` existed - a plain on/off-quiet toggle.
  // Only ever read via resolveMode(), never written anymore.
  quiet?: boolean;
}

interface AnnounceState {
  [channelId: string]: StoredChannelState;
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

// Reads a stored entry's mode, falling back to the pre-`mode` `quiet`
// boolean for state written by an older version of the bot - without this,
// a channel that was on quiet mode would silently start posting
// game-started notices again on the next restart.
export function resolveMode(entry: Pick<StoredChannelState, 'mode' | 'quiet'>): AnnounceMode {
  return entry.mode ?? (entry.quiet ? 'quiet' : 'on');
}

export function loadAnnounceState(): AnnounceState {
  return readState();
}

export function setChannelAnnouncing(channelId: string, confirmationMessageId: string, mode: AnnounceMode = 'on'): void {
  const state = readState();
  state[channelId] = { confirmationMessageId, mode };
  writeState(state);
}

export function clearChannelAnnouncing(channelId: string): void {
  const state = readState();
  delete state[channelId];
  writeState(state);
}

// Flips the mode on an already-announcing channel in place, leaving its
// confirmation-message id untouched - used when /announce switches modes
// without a full off/on cycle (see announce.ts). A no-op if the channel
// isn't in the persisted state at all (shouldn't happen in practice - the
// caller only calls this on a channel it already knows is announcing).
export function setChannelMode(channelId: string, mode: AnnounceMode): void {
  const state = readState();
  const entry = state[channelId];
  if (!entry) return;
  entry.mode = mode;
  delete entry.quiet;
  writeState(state);
}
