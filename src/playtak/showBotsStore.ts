import { createJsonStore } from './jsonStore';

// Persists which channels have /showbots off. An absent entry means on.
interface ShowBotsState {
  [channelId: string]: boolean;
}

const store = createJsonStore<ShowBotsState>('showbots-state', () => ({}));

export function getShowBots(channelId: string): boolean {
  return store.get()[channelId] ?? true;
}

export function setShowBots(channelId: string, show: boolean): void {
  const state = store.get();
  if (show) {
    delete state[channelId];
  } else {
    state[channelId] = false;
  }
  store.set(state);
}
