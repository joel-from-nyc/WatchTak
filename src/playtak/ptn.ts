import { PlaceMove, SpreadMove } from './protocol';

// Converts PlayTak wire moves to PTN (Portable Tak Notation).
//
// Not implemented: the trailing "*" PTN puts on a spread that flattens a
// wall. The wire message does not say whether that happened.

export function placeToPtn(move: PlaceMove): string {
  const square = move.square.toLowerCase();
  if (move.isCapstone) return `C${square}`;
  if (move.isWall) return `S${square}`;
  return square;
}

export function spreadToPtn(move: SpreadMove): string {
  const fromFile = move.fromSquare[0];
  const fromRank = Number(move.fromSquare.slice(1));
  const toFile = move.toSquare[0];
  const toRank = Number(move.toSquare.slice(1));

  let direction: string;
  if (toFile > fromFile) direction = '>';
  else if (toFile < fromFile) direction = '<';
  else if (toRank > fromRank) direction = '+';
  else direction = '-';

  const totalPickedUp = move.drops.reduce((sum, n) => sum + n, 0);
  const dropCounts = move.drops.join('');
  // PTN omits the count for a single stone moved one square ("a1>").
  const countPrefix = totalPickedUp === 1 && move.drops.length === 1 ? '' : String(totalPickedUp);

  return `${countPrefix}${move.fromSquare.toLowerCase()}${direction}${dropCounts}`;
}

// "1W", "1B", "2W"... for an absolute ply index (0 = white's first move).
export function plyToMoveLabel(ply: number): string {
  return `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? 'W' : 'B'}`;
}

export function moveLabelToPly(moveNumber: number, colorLetter: 'W' | 'B'): number {
  return (moveNumber - 1) * 2 + (colorLetter === 'W' ? 0 : 1);
}

// Numbered PTN move text, e.g. "1. a1 f6\n2. Cd4 Sd3". `startPly` is the
// absolute index of `plies[0]`; a list starting on black's move uses
// ellipsis notation ("12... c3").
export function formatPtnMoveList(plies: string[], startPly = 0): string {
  const moves: string[] = [];
  let i = 0;

  if (startPly % 2 === 1 && plies.length > 0) {
    moves.push(`${Math.floor(startPly / 2) + 1}... ${plies[0]}`);
    i = 1;
  }

  for (; i < plies.length; i += 2) {
    const moveNum = Math.floor((startPly + i) / 2) + 1;
    const white = plies[i];
    const black = plies[i + 1];
    moves.push(black ? `${moveNum}. ${white} ${black}` : `${moveNum}. ${white}`);
  }
  return moves.join('\n');
}
