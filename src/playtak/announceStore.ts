import fs from 'fs';
import path from 'path';

// Persists which channels have /announce on, each one's mode, and the id of
// its "now on" confirmation message (deleted on shutdown or the next start).

// `on` shows every game-started notice, `quiet` shows none, `noguest` and
// `users` filter them - see announcer.ts's modeAllowsGame().
export type AnnounceMode = 'on' | 'quiet' | 'noguest' | 'users';

// data/ at the project root, namespaced by DISCORD_GUILD_ID so two instances
// built from one dist/ keep separate files. Read lazily because index.ts
// loads the env file after this module is imported.
function getStorePath(): string {
  const guildId = process.env.DISCORD_GUILD_ID;
  const filename = guildId ? `announce-state.${guildId}.json` : 'announce-state.json';
  return path.join(__dirname, '..', '..', 'data', filename);
}

interface StoredChannelState {
  confirmationMessageId: string;
  mode?: AnnounceMode;
  // Older on/off-quiet form; read via resolveMode(), never written.
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

// Changes an announcing channel's mode, keeping its confirmation message id.
// No-op if the channel is not in the store.
export function setChannelMode(channelId: string, mode: AnnounceMode): void {
  const state = readState();
  const entry = state[channelId];
  if (!entry) return;
  entry.mode = mode;
  delete entry.quiet;
  writeState(state);
}
