import fs from 'fs';
import path from 'path';

// A /rating rule for one channel: when set, game notices there only show a
// registered human rated at least `humanMin` playing another human, or a bot
// rated at least `botMin` - hiding everything else, regardless of what
// /announce or /showbots would otherwise say - see announcer.ts's
// ratingRuleAllows(). Either bound can be omitted to mean "no minimum" on
// that side.
export interface RatingRule {
  humanMin?: number;
  botMin?: number;
}

// Mirrors showBotsStore.ts's approach - a plain JSON file, namespaced by
// DISCORD_GUILD_ID the same way, for the same reasons (see its comment).
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

// Cached in memory for the same reason as showBotsStore.ts's - see its comment.
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
