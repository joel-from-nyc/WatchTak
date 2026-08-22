import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';

// How long to let PlayTak's post-(re)connect burst of `GameList Add` lines
// land before reconciling. On every (re)connect the server replays every
// still-active game, but games that *ended* while we were disconnected are
// never told to us at all - no `GameList Remove` for them - so the replay
// is the only way to learn what's actually still active. Mirrors
// announcer.ts's RECONNECT_RECONCILE_MS for the same reason.
const RECONNECT_RECONCILE_MS = 2000;

// Tracks currently-active public games by listening to GameList Add/Remove
// events, so /list and /watch can answer instantly without round-tripping
// to PlayTak on every command.
export class GameRegistry {
  private games = new Map<number, GameListEntry>();
  // Non-undefined while a post-connect replay window is open: every
  // gameNo seen via `gameListAdd` during that window gets added here, so
  // the timeout below can tell "re-confirmed by the replay" apart from
  // "existed before the replay but never came back".
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

    // Without this, a game that ended while disconnected lingers forever:
    // it never gets a Remove, so it keeps showing up in /list and can still
    // be matched by /watch long after it's over. Snapshot what we knew
    // before the reconnect, let the replay burst land, then drop anything
    // that didn't come back - it's gone.
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

  // Case-insensitive substring match against either player's name, e.g.
  // "gruppl" matches a game with "gruppler" as white or black. Can return
  // more than one game if the query is ambiguous - callers decide what to
  // do with multiple matches.
  searchByPlayer(query: string): GameListEntry[] {
    const lower = query.toLowerCase();
    return [...this.games.values()].filter(
      (game) => game.white.toLowerCase().includes(lower) || game.black.toLowerCase().includes(lower),
    );
  }
}
