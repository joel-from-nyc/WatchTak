import { createJsonStore } from './jsonStore';

// Persists which channels have /announce on, each one's mode, and the id of
// its "now on" confirmation message (deleted on shutdown or the next start).

// `on` shows every game-started notice, `quiet` shows none, `noguest` and
// `users` filter them - see announcer.ts's modeAllowsGame().
export type AnnounceMode = 'on' | 'quiet' | 'noguest' | 'users';

interface StoredChannelState {
  confirmationMessageId: string;
  mode?: AnnounceMode;
  // Older on/off-quiet form; read via resolveMode(), never written.
  quiet?: boolean;
}

interface AnnounceState {
  [channelId: string]: StoredChannelState;
}

const store = createJsonStore<AnnounceState>('announce-state', () => ({}));

export function resolveMode(entry: Pick<StoredChannelState, 'mode' | 'quiet'>): AnnounceMode {
  return entry.mode ?? (entry.quiet ? 'quiet' : 'on');
}

export function loadAnnounceState(): AnnounceState {
  return store.get();
}

export function setChannelAnnouncing(
  channelId: string,
  confirmationMessageId: string,
  mode: AnnounceMode = 'on',
): void {
  const state = store.get();
  state[channelId] = { confirmationMessageId, mode };
  store.set(state);
}

export function clearChannelAnnouncing(channelId: string): void {
  const state = store.get();
  delete state[channelId];
  store.set(state);
}

// Changes an announcing channel's mode, keeping its confirmation message id.
// No-op if the channel is not in the store.
export function setChannelMode(channelId: string, mode: AnnounceMode): void {
  const state = store.get();
  const entry = state[channelId];
  if (!entry) return;
  entry.mode = mode;
  delete entry.quiet;
  store.set(state);
}
