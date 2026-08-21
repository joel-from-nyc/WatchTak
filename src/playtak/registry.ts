import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';

// Tracks currently-active public games by listening to GameList Add/Remove
// events, so /list and /watch can answer instantly without round-tripping
// to PlayTak on every command.
export class GameRegistry {
  private games = new Map<number, GameListEntry>();

  constructor(playtak: PlaytakClient) {
    playtak.on('event', (event) => {
      if (event.type === 'gameListAdd') {
        this.games.set(event.game.gameNo, event.game);
      } else if (event.type === 'gameListRemove') {
        this.games.delete(event.game.gameNo);
      }
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
