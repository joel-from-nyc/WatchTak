import { PlaceMove, SpreadMove } from './protocol';

// Converts PlayTak's raw wire-protocol moves into PTN (Portable Tak Notation).
//
// Known gap: a spread that flattens a standing wall with the carried
// capstone is marked in PTN with a trailing "*" (e.g. "3a1>111*"), but the
// server's raw M message doesn't say whether that happened - it would need
// board-state tracking to detect. Not implemented; the "*" is always omitted.

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
  // PTN omits the pickup-count prefix for the common single-stone,
  // single-square case (e.g. "a1>" rather than "1a1>1").
  const countPrefix = totalPickedUp === 1 && move.drops.length === 1 ? '' : String(totalPickedUp);

  return `${countPrefix}${move.fromSquare.toLowerCase()}${direction}${dropCounts}`;
}

// Formats a flat list of plies (in play order, starting with white) as
// numbered PTN move text, e.g. "1. a1 f6 2. Cd4 Sd3".
export function formatPtnMoveList(plies: string[]): string {
  const moves: string[] = [];
  for (let i = 0; i < plies.length; i += 2) {
    const moveNum = i / 2 + 1;
    const white = plies[i];
    const black = plies[i + 1];
    moves.push(black ? `${moveNum}. ${white} ${black}` : `${moveNum}. ${white}`);
  }
  return moves.join('\n');
}
