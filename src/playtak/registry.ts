import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';

// PlayTak replays every active game as `GameList Add` on (re)connect and
// never sends a `GameList Remove` for games that ended while disconnected.
// Reconciliation waits this long for the replay to land.
const RECONNECT_RECONCILE_MS = 2000;

// In-memory view of active games, from GameList Add/Remove events.
export class GameRegistry {
  private games = new Map<number, GameListEntry>();
  // Set while a post-connect replay window is open: game numbers seen
  // during the window.
  private seenDuringReplay?: Set<number>;

  constructor(playtak: PlaytakClient) {
    playtak.on('event', (event) => {
      if (event.type === 'gameListAdd') {
        this.games.set(event.game.gameNo, event.game);
        this.seenDuringReplay?.add(event.game.gameNo);
      } else if (event.type === 'gameListRemove') {
        this.games.delete(event.game.gameNo);
      }
    });

    // Games known before the reconnect that the replay did not re-send have
    // ended.
    playtak.on('connected', () => {
      const knownBeforeReplay = new Set(this.games.keys());
      this.seenDuringReplay = new Set();
      setTimeout(() => {
        const seen = this.seenDuringReplay ?? new Set();
        this.seenDuringReplay = undefined;
        for (const gameNo of knownBeforeReplay) {
          if (!seen.has(gameNo)) this.games.delete(gameNo);
        }
      }, RECONNECT_RECONCILE_MS);
    });
  }

  list(): GameListEntry[] {
    return [...this.games.values()];
  }

  find(gameNo: number): GameListEntry | undefined {
    return this.games.get(gameNo);
  }

  // Case-insensitive substring match against either player's name. May
  // return several games.
  searchByPlayer(query: string): GameListEntry[] {
    const lower = query.toLowerCase();
    return [...this.games.values()].filter(
      (game) => game.white.toLowerCase().includes(lower) || game.black.toLowerCase().includes(lower),
    );
  }
}
