import { createJsonStore } from './jsonStore';

// A channel's /rating rule: game notices there only show a registered human
// rated at least `humanMin` playing another human, or a bot rated at least
// `botMin`. Either bound may be omitted. See announcer.ts's ratingRuleAllows().
export interface RatingRule {
  humanMin?: number;
  botMin?: number;
}

interface RatingState {
  [channelId: string]: RatingRule;
}

const store = createJsonStore<RatingState>('rating-state', () => ({}));

export function getRatingRule(channelId: string): RatingRule | undefined {
  return store.get()[channelId];
}

export function setRatingRule(channelId: string, rule: RatingRule | undefined): void {
  const state = store.get();
  if (rule) {
    state[channelId] = rule;
  } else {
    delete state[channelId];
  }
  store.set(state);
}
