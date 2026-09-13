// Player ratings, polled from the JSON behind playtak.com's ratings page.
// The WebSocket protocol carries no rating information.
import { formatPlayerName, formatPlayerNameBold } from './format';

const RATINGLIST_URL = 'https://playtak.com/ratinglist.json';

const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

// One row: [name(s), rating, activeRating, gamesPlayed, isBot]. The name
// field can hold several space-separated aliases for one renamed account.
// A rating of 0 means "not rated yet".
type RatingRow = [string, number, number, number, number];

interface RatingEntry {
  rating: number;
  isBot: boolean;
}

const ratingsByName = new Map<string, RatingEntry>();

// True once a fetch has succeeded this process. Until then every rating is
// unknown, which makes a /rating rule hide everything it gates; /prune
// refuses to run in that window (see areRatingsLoaded()).
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
    // The previous cache stays in place.
    console.error('Failed to refresh PlayTak ratings:', err);
  }
}

export function areRatingsLoaded(): boolean {
  return loadedOnce;
}

export function getRating(name: string): number | undefined {
  return ratingsByName.get(name)?.rating;
}

// "gruppler (1836)", or the bare name when no rating is known.
export function formatPlayer(name: string): string {
  return formatPlayerName(name, getRating(name));
}

export function formatPlayerBold(name: string): string {
  return formatPlayerNameBold(name, getRating(name));
}

// The ratings list flags bots that only ever accept seeks and so never
// appear on a `Seek new` line of their own.
export function isRatedBot(name: string): boolean | undefined {
  return ratingsByName.get(name)?.isBot;
}

export function startRatingsRefresh(): void {
  refreshRatings().catch(() => {});
  setInterval(() => {
    refreshRatings().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}
