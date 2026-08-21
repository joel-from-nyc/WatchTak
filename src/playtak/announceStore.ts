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
const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'announce-state.json');

interface AnnounceState {
  [channelId: string]: { confirmationMessageId: string };
}

function readState(): AnnounceState {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state: AnnounceState): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
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
