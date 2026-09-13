import fs from 'fs';
import path from 'path';

// A channel's /rating rule: game notices there only show a registered human
// rated at least `humanMin` playing another human, or a bot rated at least
// `botMin`. Either bound may be omitted. See announcer.ts's ratingRuleAllows().
export interface RatingRule {
  humanMin?: number;
  botMin?: number;
}

// Same location and guild namespacing as announceStore.ts.
function getStorePath(): string {
  const guildId = process.env.DISCORD_GUILD_ID;
  const filename = guildId ? `rating-state.${guildId}.json` : 'rating-state.json';
  return path.join(__dirname, '..', '..', 'data', filename);
}

interface RatingState {
  [channelId: string]: RatingRule;
}

function readState(): RatingState {
  try {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state: RatingState): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
}

// Cached in memory; this process is the only writer.
let cached: RatingState | undefined;

function state(): RatingState {
  if (!cached) cached = readState();
  return cached;
}

export function getRatingRule(channelId: string): RatingRule | undefined {
  return state()[channelId];
}

export function setRatingRule(channelId: string, rule: RatingRule | undefined): void {
  const current = state();
  if (rule) {
    current[channelId] = rule;
  } else {
    delete current[channelId];
  }
  writeState(current);
}
