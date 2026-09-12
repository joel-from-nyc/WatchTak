import { TextChannel, ThreadChannel, Message, MessageType, ComponentType } from 'discord.js';
import { isGameActivelyWatched, parseThreadName } from './watcher';
import { parseReplayThreadName } from './catchup';
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
// The game number is optional in the text: notices from before it was added
// there (August 2026) read just "X vs Y has finished.", and still need
// pruning - parseNotice() recovers their number from the button instead.
const NOTICE_LINE_PATTERN = /^(.+?) vs (.+?)(?: \(#(\d+)\))? has (?:started!|finished\.)$/;

// The Watch/Review button seekToGame.ts attaches to every notice, whose
// customId index.ts's button handler parses the game number back out of -
// so it has carried the number on every notice ever posted, including the
// ones whose text predates it.
const NOTICE_BUTTON_PATTERN = /^watch(?:-review)?:(\d+)$/;

// Reverses formatPlayerBold()'s "**name**" / "**name** (rating)" shape back
// to the bare name - that function is the only place that builds this exact
// shape, so the pattern is stable.
const BOLD_NAME_PATTERN = /^\*\*(.+)\*\*(?: \(\d+\))?$/;

function extractName(rawBoldName: string): string | undefined {
  return BOLD_NAME_PATTERN.exec(rawBoldName)?.[1];
}

function buttonGameNo(message: Message): number | undefined {
  for (const row of message.components) {
    if (row.type !== ComponentType.ActionRow) continue;
    for (const component of row.components) {
      const match = 'customId' in component && component.customId ? NOTICE_BUTTON_PATTERN.exec(component.customId) : null;
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

export interface ParsedNotice {
  white: string;
  black: string;
  gameNo: number;
}

// Parses a bot message as a "vs ... has started!/finished." notice, or
// returns undefined if it isn't one - or is one so old it can't be tied to a
// game number by either its text or its button, in which case it's left
// alone rather than guessed at. Shared by every caller that needs to recover
// the players/game a notice was for (there's no other record of it once
// posted).
export function parseNotice(message: Message): ParsedNotice | undefined {
  const match = NOTICE_LINE_PATTERN.exec(message.content.split('\n', 1)[0]);
  if (!match) return undefined;
  const white = extractName(match[1]);
  const black = extractName(match[2]);
  if (white === undefined || black === undefined) return undefined;
  const gameNo = match[3] !== undefined ? Number(match[3]) : buttonGameNo(message);
  if (gameNo === undefined) return undefined;
  return { white, black, gameNo };
}

// Discord's own "WatchTak started a thread: ..." system line, posted in the
// parent channel whenever the bot opens a game thread. Its message id is the
// thread's id (confirmed against the live channel: so is its
// message_reference.channel_id, and its content is the thread's name), which
// is what lets a caller tell whether the thread it points at still exists.
// Deleting a thread does *not* remove this line, so without explicit cleanup
// every pruned thread leaves one behind - exactly the clutter that piled up
// before this was handled.
export function isThreadStarterMessage(message: Message, botId: string | undefined): boolean {
  return message.type === MessageType.ThreadCreated && message.author.id === botId;
}

// Deletes a thread along with its "started a thread" line in the parent
// channel (see isThreadStarterMessage() for why they share an id). Returns
// whether the thread itself went; the starter line is best-effort on top.
export async function deleteThread(thread: ThreadChannel): Promise<boolean> {
  const deleted = await thread
    .delete()
    .then(() => true)
    .catch((err) => {
      console.error(`Failed to delete thread "${thread.name}":`, err);
      return false;
    });
  const parent = thread.parent;
  if (deleted && parent && 'messages' in parent) await parent.messages.delete(thread.id).catch(() => {});
  return deleted;
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

// Discord refuses to bulk-delete any message older than two weeks, so
// anything past this has to go one API call at a time - see deleteMessages().
const MAX_BULK_DELETE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Discord's own cap on one bulk-delete call.
const BULK_DELETE_BATCH = 100;

async function deleteOne(message: Message): Promise<boolean> {
  return message
    .delete()
    .then(() => true)
    .catch(() => false);
}

// Deletes a batch of this bot's messages, returning the ids that actually
// went. Individual deletion is heavily throttled - it's what once left a
// /prune run looking hung for minutes - so anything young enough goes
// through bulkDelete instead, 100 per API call. Two things force the
// one-at-a-time path: a message over two weeks old, which Discord refuses to
// bulk-delete at all, and a channel where the bot lacks Manage Messages,
// which bulk deletion requires but deleting one's own messages does not.
// Neither is an error worth surfacing to the caller - the work still
// completes, just slower - so the fallback is silent apart from one log
// line, and the returned ids are the honest record of what was removed.
export async function deleteMessages(channel: TextChannel, messages: Message[]): Promise<string[]> {
  if (messages.length === 0) return [];

  const now = Date.now();
  const deleted: string[] = [];
  const bulkable: Message[] = [];
  const individual: Message[] = [];
  for (const message of messages) {
    (now - message.createdTimestamp < MAX_BULK_DELETE_AGE_MS ? bulkable : individual).push(message);
  }

  let bulkUnavailable = false;
  for (let index = 0; index < bulkable.length; index += BULK_DELETE_BATCH) {
    const batch = bulkable.slice(index, index + BULK_DELETE_BATCH);
    // Once bulk deletion has failed here it will keep failing for the same
    // reason (almost always a missing permission), so stop retrying it.
    if (!bulkUnavailable) {
      try {
        await channel.bulkDelete(batch);
        deleted.push(...batch.map((message) => message.id));
        continue;
      } catch (err) {
        bulkUnavailable = true;
        console.error(`Bulk delete unavailable in channel ${channel.id}, falling back to one at a time:`, err);
      }
    }
    for (const message of batch) if (await deleteOne(message)) deleted.push(message.id);
  }

  for (const message of individual) if (await deleteOne(message)) deleted.push(message.id);
  return deleted;
}

// This bot's own *watch* threads out of `threads`, keyed by PlayTak game
// number - shared by every caller that needs to answer "does a real thread
// exist for this notice's game" (and, for autoPrune.ts, get the thread
// itself back to inspect/delete). Replay threads never match here (their
// names deliberately fail parseThreadName()) - a game's notice points at its
// watch thread, never its replay; see listReplayThreads() for those.
export function mapThreadsByGameNo(threads: ThreadChannel[], botId: string | undefined): Map<number, ThreadChannel> {
  const byGameNo = new Map<number, ThreadChannel>();
  for (const thread of threads) {
    if (thread.ownerId !== botId) continue;
    const parsed = parseThreadName(thread.name);
    if (parsed) byGameNo.set(parsed.gameNo, thread);
  }
  return byGameNo;
}

// This bot's /expand new replay threads out of `threads`. A replay thread
// has no notice of its own, so the notice-driven scans never reach one - it
// needs its own pass. The watcher closes a replay that's still attached as
// a live mirror when its game ends, but a restart severs that link, after
// which nothing else would ever clean it up.
export function listReplayThreads(
  threads: ThreadChannel[],
  botId: string | undefined,
): { thread: ThreadChannel; gameNo: number }[] {
  const replays: { thread: ThreadChannel; gameNo: number }[] = [];
  for (const thread of threads) {
    if (thread.ownerId !== botId) continue;
    const parsed = parseReplayThreadName(thread.name);
    if (parsed) replays.push({ thread, gameNo: parsed.gameNo });
  }
  return replays;
}
