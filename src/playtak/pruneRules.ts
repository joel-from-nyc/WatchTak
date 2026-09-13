import { TextChannel, ThreadChannel, Message, MessageType, ComponentType } from 'discord.js';
import { isGameActivelyWatched, parseThreadName } from './watcher';
import { parseReplayThreadName } from './catchup';
import { getGameRegistry } from './shared';

// Scanning and deletion primitives shared by /prune (commands/prune.ts) and
// the automatic sweep (autoPrune.ts).

// First line of a game notice: "X vs Y (#123) has started!" or
// "... has finished.". The game number is optional in the text; older
// notices carry it only in their button's customId.
const NOTICE_LINE_PATTERN = /^(.+?) vs (.+?)(?: \(#(\d+)\))? has (?:started!|finished\.)$/;

// customId of the Watch/Review button on every notice.
const NOTICE_BUTTON_PATTERN = /^watch(?:-review)?:(\d+)$/;

// Reverses formatPlayerBold(): "**name**" or "**name** (rating)".
const BOLD_NAME_PATTERN = /^\*\*(.+)\*\*(?: \(\d+\))?$/;

function extractName(rawBoldName: string): string | undefined {
  return BOLD_NAME_PATTERN.exec(rawBoldName)?.[1];
}

function buttonGameNo(message: Message): number | undefined {
  for (const row of message.components) {
    if (row.type !== ComponentType.ActionRow) continue;
    for (const component of row.components) {
      const match =
        'customId' in component && component.customId ? NOTICE_BUTTON_PATTERN.exec(component.customId) : null;
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

// Parses a bot message as a game notice. Returns undefined if it is not
// one, or if no game number can be recovered from text or button.
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

// Discord's "started a thread" system message in the parent channel. Its
// message id equals the thread's id. Discord does not remove it when the
// thread is deleted.
export function isThreadStarterMessage(message: Message, botId: string | undefined): boolean {
  return message.type === MessageType.ThreadCreated && message.author.id === botId;
}

// Deletes a thread and its "started a thread" line. Returns whether the
// thread itself was deleted; the line is best-effort.
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

// "Older than a day" threshold for every staleness check.
export const STALE_AGE_MS = 24 * 60 * 60 * 1000;

// The registry is checked as well as the in-memory watch, since the watch
// map is empty right after a restart while the registry is replayed.
export function isGameStillLive(gameNo: number): boolean {
  return isGameActivelyWatched(gameNo) || getGameRegistry().find(gameNo) !== undefined;
}

// Page caps for channel-message and thread scans.
export const MAX_MESSAGE_PAGES = 10;
export const MESSAGE_PAGE_SIZE = 100;

const MAX_THREAD_PAGES = 5;
const THREAD_PAGE_SIZE = 100;

// Pages of a thread's messages to check for human participation.
const MAX_HUMAN_CHECK_PAGES = 5;

// Whether any non-bot account has posted in the thread. Returns undefined if
// a fetch failed before one was found; callers must treat that differently
// from a definite false, since false clears a thread for deletion.
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

// The channel's active threads plus up to MAX_THREAD_PAGES of archived ones.
// `complete` is false if any fetch failed or the archived list was cut off,
// in which case "not found" cannot be trusted to mean "does not exist".
export async function collectChannelThreads(
  channel: TextChannel,
): Promise<{ threads: ThreadChannel[]; complete: boolean }> {
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

// Discord refuses to bulk-delete messages older than two weeks.
const MAX_BULK_DELETE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Discord's cap on one bulk-delete call.
const BULK_DELETE_BATCH = 100;

async function deleteOne(message: Message): Promise<boolean> {
  return message
    .delete()
    .then(() => true)
    .catch(() => false);
}

// Deletes the bot's messages, returning the ids that were actually deleted.
// Messages under two weeks old go through bulkDelete, 100 per call. Older
// messages, and every message if bulk deletion fails (it requires Manage
// Messages), are deleted one at a time.
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

// The bot's watch threads, keyed by game number. Replay threads do not match
// (their names fail parseThreadName()).
export function mapThreadsByGameNo(threads: ThreadChannel[], botId: string | undefined): Map<number, ThreadChannel> {
  const byGameNo = new Map<number, ThreadChannel>();
  for (const thread of threads) {
    if (thread.ownerId !== botId) continue;
    const parsed = parseThreadName(thread.name);
    if (parsed) byGameNo.set(parsed.gameNo, thread);
  }
  return byGameNo;
}

// The bot's /expand new replay threads. These have no notice pointing at
// them, so the notice-driven scans need a separate pass for them.
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
