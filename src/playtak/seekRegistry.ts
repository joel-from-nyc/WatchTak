import { PlaytakClient } from './client';
import { Seek } from './protocol';

// Tracks currently-open public seeks (excludes private challenges - see the
// `opponent` field check) for on-demand /seeks lookups. No channel posting
// or pruning - that was removed in favor of querying on demand.
export class SeekRegistry {
  private seeks = new Map<number, Seek>();

  constructor(playtak: PlaytakClient) {
    playtak.on('event', (event) => {
      if (event.type === 'seekNew' && event.seek.opponent === '') {
        this.seeks.set(event.seek.id, event.seek);
      } else if (event.type === 'seekRemove') {
        this.seeks.delete(event.seek.id);
      }
    });
  }

  list(): Seek[] {
    return [...this.seeks.values()];
  }
}
