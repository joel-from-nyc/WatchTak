import { TextChannel, ThreadChannel } from 'discord.js';
import { isGameActivelyWatched, parseThreadName } from './watcher';
import { getGameRegistry } from './shared';

// Staleness/scanning primitives shared by the manual /prune command
// (commands/prune.ts) and the silent automatic sweep (autoPrune.ts) - kept
// here, in playtak/, rather than in commands/prune.ts, so a background job
// that isn't a slash command at all doesn't have to reach into src/commands/
// for it.

// Matches the first line of both notice shapes seekToGame.ts builds -
// "X vs Y (#123) has started!" / "X vs Y (#123) has finished." - loosely
// enough to survive either verb, tightly enough that nothing else in the
// channel accidentally matches. Player names never contain spaces (PlayTak
// usernames are single wire tokens), so splitting on " vs " is unambiguous.
// The game number is captured too, for the orphaned-notice check.
const NOTICE_LINE_PATTERN = /^(.+?) vs (.+?) \(#(\d+)\) has (?:started!|finished\.)$/;

// Reverses formatPlayerBold()'s "**name**" / "**name** (rating)" shape back
// to the bare name - that function is the only place that builds this exact
// shape, so the pattern is stable.
const BOLD_NAME_PATTERN = /^\*\*(.+)\*\*(?: \(\d+\))?$/;

function extractName(rawBoldName: string): string | undefined {
  return BOLD_NAME_PATTERN.exec(rawBoldName)?.[1];
}

export interface ParsedNotice {
  white: string;
  black: string;
  gameNo: number;
}

// Parses a message's first line as a "vs ... has started!/finished." notice,
// or returns undefined if it doesn't match that shape at all - shared by
// every caller that needs to recover the players/game number a notice was
// for from its own text (there's no other record of it once posted).
export function parseNoticeLine(firstLine: string): ParsedNotice | undefined {
  const match = NOTICE_LINE_PATTERN.exec(firstLine);
  if (!match) return undefined;
  const white = extractName(match[1]);
  const black = extractName(match[2]);
  if (white === undefined || black === undefined) return undefined;
  return { white, black, gameNo: Number(match[3]) };
}

// "Older than a day" threshold for every staleness check below - a separate
// concern from watcher.ts's own THREAD_CLOSE_DELAY_MS (which happens to
// share the same value), not worth sharing between the two files.
export const STALE_AGE_MS = 24 * 60 * 60 * 1000;

// isGameActivelyWatched() is wiped by a process restart (in-memory only) -
// the game registry survives one (PlayTak replays the whole active game
// list on reconnect - see registry.ts), so checking it too closes the gap:
// without it, a genuinely live game whose thread happens to have no chat
// yet, hit right after a restart, would look identical to an abandoned one.
export function isGameStillLive(gameNo: number): boolean {
  return isGameActivelyWatched(gameNo) || getGameRegistry().find(gameNo) !== undefined;
}

// One channel-message scan (for stale/orphaned notices) covers at most this
// many messages (10 pages of Discord's own 100-per-fetch cap) - enough for a
// realistic backscroll without an open-ended API scan.
export const MAX_MESSAGE_PAGES = 10;
export const MESSAGE_PAGE_SIZE = 100;

// Threads accumulate far more slowly than messages, so a much smaller cap
// (5 pages of 100 archived threads) comfortably covers a realistic amount of
// game history without an open-ended scan.
const MAX_THREAD_PAGES = 5;
const THREAD_PAGE_SIZE = 100;

// How many pages of a single thread's own messages to check for human
// participation before giving up and assuming there isn't any - a real
// conversation could be anywhere among the bot's own move-by-move posts, so
// this needs to be generous, but still bounded (500 messages is far more
// than any of these threads realistically carries).
const MAX_HUMAN_CHECK_PAGES = 5;

// Whether any human has ever posted in this thread. `author.bot` is
// Discord's own flag for a bot/application account, so this correctly
// excludes both this bot's own move-by-move posts and anything any other bot
// might have said - only a genuine human message counts. Returns undefined
// when a fetch failed before any human turned up - "couldn't tell", which
// every caller must treat differently from a definite `false`, since the
// answer gates deleting a thread that might hold a real conversation.
export async function threadHasHumanMessages(thread: ThreadChannel): Promise<boolean | undefined> {
  let before: string | undefined;
  for (let page = 0; page < MAX_HUMAN_CHECK_PAGES; page++) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch) return undefined;
    if (batch.size === 0) break;
    for (const message of batch.values()) {
      if (!message.author.bot) return true;
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return false;
}

// This channel's own threads, active plus a bounded page of archived ones.
// `complete` is false whenever a fetch failed, or the archived list still
// had more pages past MAX_THREAD_PAGES - callers that read "no thread found"
// as "no thread exists" (an orphaned-notice check) must only trust that
// conclusion when the scan covered everything.
export async function collectChannelThreads(channel: TextChannel): Promise<{ threads: ThreadChannel[]; complete: boolean }> {
  const threads: ThreadChannel[] = [];
  let complete = true;

  const active = await channel.threads.fetchActive().catch(() => null);
  if (active) threads.push(...active.threads.values());
  else complete = false;

  let before: ThreadChannel | undefined;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const archived = await channel.threads.fetchArchived({ limit: THREAD_PAGE_SIZE, before }).catch(() => null);
    if (!archived) {
      complete = false;
      break;
    }
    if (archived.threads.size === 0) break;
    threads.push(...archived.threads.values());
    before = archived.threads.last();
    if (!archived.hasMore) break;
    if (page === MAX_THREAD_PAGES - 1) complete = false;
  }
  return { threads, complete };
}

// This bot's own game threads out of `threads`, keyed by PlayTak game number
// - shared by every caller that needs to answer "does a real thread exist
// for this notice's game" (and, for autoPrune.ts, get the thread itself back
// to inspect/delete).
export function mapThreadsByGameNo(threads: ThreadChannel[], botId: string | undefined): Map<number, ThreadChannel> {
  const byGameNo = new Map<number, ThreadChannel>();
  for (const thread of threads) {
    if (thread.ownerId !== botId) continue;
    const parsed = parseThreadName(thread.name);
    if (parsed) byGameNo.set(parsed.gameNo, thread);
  }
  return byGameNo;
}
