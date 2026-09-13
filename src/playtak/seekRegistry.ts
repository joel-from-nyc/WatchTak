import { PlaytakClient } from './client';
import { Seek } from './protocol';

// In-memory view of open public seeks. Private challenges (a non-empty
// `opponent`) are excluded.
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
