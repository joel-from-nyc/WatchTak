import { codeBlock, alignedLine } from './format';
import { formatPtnMoveList, plyToMoveLabel, moveLabelToPly } from './ptn';

// Catch-up summaries: when a watch thread is missing boards for a span of
// moves (a game watched from mid-flight, or moves missed during a
// disconnect), the missed moves are posted as text "chunk" messages of at
// most CHUNK_MAX_PLIES plies each rather than one big dump. The sizing is
// what makes /expand here possible later: Discord can't insert messages
// into a thread's past, but the tail of the thread at catch-up time IS the
// right place in the timeline, and a bot may edit its own old messages to
// add attachments - so each chunk is a permanent slot that /expand can fill
// in place with one board image per ply, and Discord caps a message at 10
// attachments. See expand.ts for the filling side, and armSettleTimer() in
// watcher.ts for the posting side.

// Discord's per-message attachment cap - one board image per ply.
export const CHUNK_MAX_PLIES = 10;

// A reconnect gap at or under this many plies skips the chunk shape
// entirely: drawing each missed move as its own live-style board message
// costs exactly as many messages as a text placeholder would, so there's
// nothing to defer - see armSettleTimer() in watcher.ts.
export const INLINE_CATCHUP_MAX_PLIES = 10;

// First line of every chunk message (inside its code block) - both the
// human-readable header and the machine marker /expand and
// findKnownPlyCount() recover the ply range from after a restart, when
// nothing in memory remembers what was posted.
export const CHUNK_HEADER_PATTERN = /^Moves (\d+)([WB])-(\d+)([WB])\b/m;

export const CHUNK_HINT = 'Run /expand here to draw these boards, or /expand new for a replay thread.';

// Replaces CHUNK_HINT when /expand finds a chunk whose listed moves no
// longer match the game's actual history (a takeback rewrote them after the
// chunk was posted) - marks the chunk permanently unexpandable so reruns
// skip it instead of re-checking forever.
export const STALE_CHUNK_NOTE = "These moves were rewritten by a takeback - boards can't be drawn.";

// Every "Label: value" line in a thread pads its label to the same width, so
// the colon column lines up down the whole message history. The labels
// themselves ("Move", "White Time", "Black Time") are fixed, so this is a
// constant rather than something computed per game.
export const MOVE_LABEL_WIDTH = Math.max('Move'.length, 'White Time'.length, 'Black Time'.length);

// The aligned `Move:       12W. Cd4` line - same shape as live move posts.
export function moveLine(ply: number, ptn: string): string {
  return alignedLine('Move', `${plyToMoveLabel(ply)}. ${ptn}`, MOVE_LABEL_WIDTH);
}

// A move message carrying only its "Move:" line - used for missed moves
// (whose clock values are unknown, so no time lines) both by inline
// reconnect catch-ups and by /expand new's replay thread. Starts with
// "Move:" on purpose: findKnownPlyCount()'s MOVE_LINE_PATTERN reads ply
// counts back out of these after a restart, same as live move posts.
export function moveOnlyText(ply: number, ptn: string): string {
  return codeBlock([moveLine(ply, ptn)]);
}

function chunkHeader(fromPly: number, toPly: number): string {
  return `Moves ${plyToMoveLabel(fromPly)}-${plyToMoveLabel(toPly)}`;
}

export interface ChunkRange {
  fromPly: number;
  toPly: number;
}

export function parseChunkHeader(content: string): ChunkRange | undefined {
  const match = CHUNK_HEADER_PATTERN.exec(content);
  if (!match) return undefined;
  return {
    fromPly: moveLabelToPly(Number(match[1]), match[2] as 'W' | 'B'),
    toPly: moveLabelToPly(Number(match[3]), match[4] as 'W' | 'B'),
  };
}

function chunkMoveList(allPlies: string[], fromPly: number, toPly: number): string {
  return formatPtnMoveList(allPlies.slice(fromPly, toPly + 1), fromPly);
}

function unfilledChunkContent(allPlies: string[], fromPly: number, toPly: number): string {
  return codeBlock([
    `${chunkHeader(fromPly, toPly)} (boards not drawn)`,
    '',
    chunkMoveList(allPlies, fromPly, toPly),
    '',
    CHUNK_HINT,
  ]);
}

// What a chunk's text becomes once its boards are attached - the
// parenthetical and the hint drop away, the range and move list stay.
export function filledChunkContent(allPlies: string[], fromPly: number, toPly: number): string {
  return codeBlock([chunkHeader(fromPly, toPly), '', chunkMoveList(allPlies, fromPly, toPly)]);
}

// The chunk's own original text with the hint swapped for the stale note -
// built from the existing content rather than regenerated, since the whole
// point is that the current plies no longer produce this move list.
export function markChunkStale(content: string): string {
  return content.replace(CHUNK_HINT, STALE_CHUNK_NOTE);
}

// The exact move-list text a chunk covering [fromPly, toPly] carries -
// /expand compares this against a chunk's current content to detect a
// takeback having rewritten history since the chunk was posted (both sides
// come from chunkMoveList, so an unchanged history matches byte-for-byte).
export function expectedChunkMoveList(allPlies: string[], fromPly: number, toPly: number): string {
  return chunkMoveList(allPlies, fromPly, toPly);
}

// Splits everything from `fromPly` onward into unfilled chunk-message
// bodies, in posting order.
export function buildChunkContents(allPlies: string[], fromPly: number): string[] {
  const contents: string[] = [];
  for (let start = fromPly; start < allPlies.length; start += CHUNK_MAX_PLIES) {
    const end = Math.min(start + CHUNK_MAX_PLIES, allPlies.length) - 1;
    contents.push(unfilledChunkContent(allPlies, start, end));
  }
  return contents;
}
