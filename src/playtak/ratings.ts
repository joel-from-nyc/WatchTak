// Caches player ratings from PlayTak's own ratings page data, for /rating's
// threshold overrides (see ratingStore.ts and announcer.ts). The WebSocket
// protocol carries no rating information at all, but the ratings page at
// https://playtak.com/ratings.html loads its table from this JSON endpoint -
// confirmed by reading that page's own js/ratinglist.js, not guessed.
import { formatPlayerName, formatPlayerNameBold } from './format';

const RATINGLIST_URL = 'https://playtak.com/ratinglist.json';

// Ratings don't move fast enough to need more - one fetch of this small file
// per interval is far gentler on PlayTak's server than looking up players
// individually, and this is the same interval whether one channel or ten
// have a /rating override active.
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

// One row of https://playtak.com/ratinglist.json: [name(s), rating,
// activeRating, gamesPlayed, isBot]. `name(s)` can be more than one
// space-separated name for a single account that's been renamed - confirmed
// from ratinglist.js's own formatnames()/row-id logic, which splits on
// spaces and links each token to the same row. A `rating` of 0 is PlayTak's
// own "no rating yet" sentinel (ratinglist.js filters those rows out of the
// page entirely), so it's treated as unknown here too.
type RatingRow = [string, number, number, number, number];

interface RatingEntry {
  rating: number;
  isBot: boolean;
}

const ratingsByName = new Map<string, RatingEntry>();

// True once the first fetch has *succeeded* at least once since this process
// started. `ratingsByName` starts empty and startRatingsRefresh()'s first
// fetch is fire-and-forget - nothing awaits it - so there's a real window
// right after every restart where getRating() returns undefined for every
// player. During that window a configured /rating override can't match
// anything (ratingOverrideMatches() in announcer.ts requires both ratings to
// be known), silently acting as if it were never set. That's tolerable for
// live announcing (worst case: a notice is briefly missed, self-corrects on
// the next event) but not for /prune, which deletes - see
// prune.ts's areRatingsLoaded() check before it runs.
let loadedOnce = false;

async function refreshRatings(): Promise<void> {
  try {
    const response = await fetch(RATINGLIST_URL);
    if (!response.ok) return;
    const rows: RatingRow[] = await response.json();

    const fresh = new Map<string, RatingEntry>();
    for (const [names, rating, , , isBotFlag] of rows) {
      if (rating === 0) continue;
      const entry: RatingEntry = { rating, isBot: isBotFlag === 1 };
      for (const name of names.split(' ')) {
        if (name) fresh.set(name, entry);
      }
    }

    ratingsByName.clear();
    for (const [name, entry] of fresh) ratingsByName.set(name, entry);
    if (!loadedOnce) console.log(`Loaded PlayTak ratings for ${ratingsByName.size} players.`);
    loadedOnce = true;
  } catch (err) {
    // Keep serving whatever was cached from the last successful fetch rather
    // than letting a transient failure blank out every /rating override.
    console.error('Failed to refresh PlayTak ratings:', err);
  }
}

// Whether ratingsByName has ever been successfully populated this process -
// see the comment on `loadedOnce` above.
export function areRatingsLoaded(): boolean {
  return loadedOnce;
}

export function getRating(name: string): number | undefined {
  return ratingsByName.get(name)?.rating;
}

// "gruppler (1836)" for a rated player, bare "Guest672" for anyone the ratings
// list doesn't cover. Used for every player name shown in the main channel -
// seek announcements and game-started/finished notices.
export function formatPlayer(name: string): string {
  return formatPlayerName(name, getRating(name));
}

// Same as formatPlayer(), but with the name bolded and the rating left plain
// - for the main-channel messages that bold player names (seek/started/
// finished notices).
export function formatPlayerBold(name: string): string {
  return formatPlayerNameBold(name, getRating(name));
}

// An extra bot-detection signal, on top of announcer.ts's knownBotByName: the
// ratings list flags a player as a bot even if they only ever accept seeks
// and never post their own, which is otherwise undetectable from the wire
// protocol alone.
export function isRatedBot(name: string): boolean | undefined {
  return ratingsByName.get(name)?.isBot;
}

export function startRatingsRefresh(): void {
  refreshRatings().catch(() => {});
  setInterval(() => {
    refreshRatings().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}
