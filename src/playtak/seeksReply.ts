import { Seek } from './protocol';
import { getSeekRegistry } from './shared';

function describeSeek(seek: Seek): string {
  const minutes = Math.floor(seek.timeSeconds / 60);
  const color = seek.color === 'A' ? 'either color' : seek.color === 'W' ? 'white' : 'black';
  const rated = seek.unrated ? 'unrated' : 'rated';
  return `**${seek.player}** - ${seek.boardSize}x${seek.boardSize}, ${minutes}+${seek.incrementSeconds}, ${color}, ${rated}`;
}

export function buildSeeksReply(): string {
  const seeks = getSeekRegistry().list();
  if (seeks.length === 0) return 'No open seeks on PlayTak right now.';
  return seeks.map(describeSeek).join('\n');
}
