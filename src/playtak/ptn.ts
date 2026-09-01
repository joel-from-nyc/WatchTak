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

// "1W", "1B", "2W"... - the move-number-plus-color label for an absolute ply
// index (0 = white's first move). The same shape the watcher's "Move:" lines
// and catch-up chunk headers use, so a ply count can be recovered from a
// thread's own message history by parsing the label back (see
// moveLabelToPly and findKnownPlyCount() in watcher.ts).
export function plyToMoveLabel(ply: number): string {
  return `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? 'W' : 'B'}`;
}

// Reverses plyToMoveLabel() from its parsed-out parts.
export function moveLabelToPly(moveNumber: number, colorLetter: 'W' | 'B'): number {
  return (moveNumber - 1) * 2 + (colorLetter === 'W' ? 0 : 1);
}

// Formats a flat list of plies (in play order, starting with white) as
// numbered PTN move text, e.g. "1. a1 f6 2. Cd4 Sd3". `startPly` is the
// absolute ply index (0 = white's first move) that `plies[0]` represents -
// needed when formatting a suffix of a game rather than the whole thing
// (e.g. only the moves missed during a reconnect). A suffix that starts
// mid-pair (black to move) is shown with ellipsis notation ("12... c3"),
// matching standard chess/PTN convention for "black moved, white's part
// already known".
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
