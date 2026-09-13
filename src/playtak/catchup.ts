import { codeBlock, alignedLine } from './format';
import { formatPtnMoveList, plyToMoveLabel, moveLabelToPly } from './ptn';

// Catch-up summaries: when a thread is missing boards for a span of moves (a
// game watched from mid-flight, or moves missed during a disconnect), the
// missed moves are posted as text "chunk" messages of at most CHUNK_MAX_PLIES
// each. Discord allows 10 attachments per message and lets a bot edit its
// own old messages, so /expand here can later attach one board per ply to
// each chunk in place.

// Discord's per-message attachment cap.
export const CHUNK_MAX_PLIES = 10;

// A reconnect gap at or under this many plies is drawn inline, one board
// message per move, instead of chunked.
export const INLINE_CATCHUP_MAX_PLIES = 10;

// First line of every chunk message. Parsed back out by /expand and by
// findKnownPlyCount() in watcher.ts.
export const CHUNK_HEADER_PATTERN = /^Moves (\d+)([WB])-(\d+)([WB])\b/m;

export const CHUNK_HINT = 'Run /expand here to draw these boards, or /expand new for a replay thread.';

// Replaces CHUNK_HINT when a takeback has rewritten a chunk's moves, so
// later /expand runs skip it.
export const STALE_CHUNK_NOTE = "These moves were rewritten by a takeback - boards can't be drawn.";

// Replay thread names deliberately do not match the watcher's "(#N)" thread
// pattern, so the sweep never adopts one and /expand refuses to run in one.
const REPLAY_THREAD_PATTERN = /^Replay: (.+) vs (.+) - game (\d+)$/;

export function replayThreadName(white: string, black: string, gameNo: number): string {
  return `Replay: ${white} vs ${black} - game ${gameNo}`;
}

export function parseReplayThreadName(name: string): { white: string; black: string; gameNo: number } | undefined {
  const match = REPLAY_THREAD_PATTERN.exec(name);
  if (!match) return undefined;
  return { white: match[1], black: match[2], gameNo: Number(match[3]) };
}

// Label width for the "Move"/"White Time"/"Black Time" lines, so the colon
// column lines up across every post.
export const MOVE_LABEL_WIDTH = Math.max('Move'.length, 'White Time'.length, 'Black Time'.length);

export function moveLine(ply: number, ptn: string): string {
  return alignedLine('Move', `${plyToMoveLabel(ply)}. ${ptn}`, MOVE_LABEL_WIDTH);
}

// A move message with only its "Move:" line, for moves whose clock values
// are unknown.
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

// A chunk's text once its boards are attached.
export function filledChunkContent(allPlies: string[], fromPly: number, toPly: number): string {
  return codeBlock([chunkHeader(fromPly, toPly), '', chunkMoveList(allPlies, fromPly, toPly)]);
}

export function markChunkStale(content: string): string {
  return content.replace(CHUNK_HINT, STALE_CHUNK_NOTE);
}

// The move-list text a chunk covering [fromPly, toPly] carries. /expand
// compares it against the chunk's current content to detect a takeback.
export function expectedChunkMoveList(allPlies: string[], fromPly: number, toPly: number): string {
  return chunkMoveList(allPlies, fromPly, toPly);
}

// Splits everything from `fromPly` onward into unfilled chunk messages.
export function buildChunkContents(allPlies: string[], fromPly: number): string[] {
  const contents: string[] = [];
  for (let start = fromPly; start < allPlies.length; start += CHUNK_MAX_PLIES) {
    const end = Math.min(start + CHUNK_MAX_PLIES, allPlies.length) - 1;
    contents.push(unfilledChunkContent(allPlies, start, end));
  }
  return contents;
}
