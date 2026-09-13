import { TextChannel, ThreadChannel } from 'discord.js';
import { moveLabelToPly } from './ptn';
import { parseChunkHeader } from './catchup';

// Finding a game's watch thread in Discord, and reading back what it already
// shows. The process keeps no persistent record of its threads; their names
// and message history are the source of truth after a restart.

// Every watch thread's name ends in "(#<gameNo>)".
export const THREAD_NAME_PATTERN = /\(#(\d+)\)$/;

export function threadName(white: string, black: string, gameNo: number): string {
  return `${white} vs ${black} (#${gameNo})`;
}

// Reverses threadName(). PlayTak usernames contain no spaces, so " vs " is an
// unambiguous separator.
export function parseThreadName(name: string): { white: string; black: string; gameNo: number } | undefined {
  const match = /^(.+) vs (.+) \(#(\d+)\)$/.exec(name);
  if (!match) return undefined;
  return { white: match[1], black: match[2], gameNo: Number(match[3]) };
}

// The "Move: <number><W|B>. <ptn>" line of a move post.
const MOVE_LINE_PATTERN = /^Move:\s+(\d+)([WB])\b/m;

// Recovers how many plies a thread already shows from its own messages: the
// highest ply in any move post or chunk summary header. Returns undefined
// when nothing carries a ply number.
export async function findKnownPlyCount(thread: ThreadChannel): Promise<number | undefined> {
  const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return undefined;

  let highestPly: number | undefined;
  for (const message of recent.values()) {
    const match = MOVE_LINE_PATTERN.exec(message.content);
    if (match) {
      const ply = moveLabelToPly(Number(match[1]), match[2] as 'W' | 'B');
      if (highestPly === undefined || ply > highestPly) highestPly = ply;
    }
    const chunk = parseChunkHeader(message.content);
    if (chunk && (highestPly === undefined || chunk.toPly > highestPly)) highestPly = chunk.toPly;
  }
  return highestPly === undefined ? undefined : highestPly + 1;
}

const MAX_ARCHIVED_THREAD_PAGES = 5;

// Finds this bot's thread for `gameNo` in the channel. Active threads are
// always checked; archived ones only when `includeArchived` is set, since
// paging through them costs extra API calls.
export async function findExistingThread(
  parentChannel: TextChannel,
  gameNo: number,
  botId: string | undefined,
  includeArchived: boolean,
): Promise<ThreadChannel | undefined> {
  const active = await parentChannel.threads.fetchActive().catch(() => null);
  for (const thread of active?.threads.values() ?? []) {
    if (thread.ownerId === botId && parseThreadName(thread.name)?.gameNo === gameNo) return thread;
  }
  if (!includeArchived) return undefined;

  let before: ThreadChannel | undefined;
  for (let page = 0; page < MAX_ARCHIVED_THREAD_PAGES; page++) {
    const archived = await parentChannel.threads.fetchArchived({ limit: 100, before }).catch(() => null);
    if (!archived || archived.threads.size === 0) break;
    for (const thread of archived.threads.values()) {
      if (thread.ownerId === botId && parseThreadName(thread.name)?.gameNo === gameNo) return thread;
    }
    before = archived.threads.last();
    if (!archived.hasMore) break;
  }
  return undefined;
}
