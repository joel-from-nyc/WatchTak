import { ThreadChannel, Message } from 'discord.js';

// A finished game's thread carries one close-lifecycle message, in one of two
// states: the pending warning (with a `<t:...:R>` deadline), or the archived
// record closeThread() rewrites it into. The message is the durable record:
// the close timer and the periodic sweep both read it and make the same
// decision from it, so the behavior survives a restart.

const THREAD_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;

const CLOSE_WARNING_PREFIX = 'This thread will be archived';
const CLOSE_ARCHIVED_PREFIX = 'This thread was archived on';
const CLOSE_MARKER_PATTERN = new RegExp(`^(?:${CLOSE_WARNING_PREFIX}|${CLOSE_ARCHIVED_PREFIX})`);

// Extracts the close deadline (Unix seconds) from a pending warning message.
const CLOSE_WARNING_DEADLINE_PATTERN = /<t:(\d+):R>/;

// A warning is only rewritten when its deadline moves by more than this.
const CLOSE_DEADLINE_SLOP_MS = 60 * 1000;

// A thread's close-lifecycle message and what the close decision needs from it.
export interface CloseMarker {
  message: Message;
  alreadyArchived: boolean;
  // Deadline shown by a pending warning. Undefined once archived or if
  // unparseable, in which case closeDueAt() uses activity alone, so a broken
  // marker can only delay a close.
  deadlineMs?: number;
  // Timestamp of the thread's newest message.
  lastActivityMs: number;
}

function warningText(deadlineMs: number): string {
  return `${CLOSE_WARNING_PREFIX} <t:${Math.floor(deadlineMs / 1000)}:R>.`;
}

// Finds the thread's close marker among its last 100 messages (post-game
// discussion can run long, and missing the marker would post a duplicate).
export async function findCloseMarker(thread: ThreadChannel): Promise<CloseMarker | undefined> {
  const recent = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  const message = recent?.find((m) => CLOSE_MARKER_PATTERN.test(m.content));
  if (!recent || !message) return undefined;
  const lastActivityMs = Math.max(...recent.map((m) => m.createdTimestamp));
  if (message.content.startsWith(CLOSE_ARCHIVED_PREFIX)) return { message, alreadyArchived: true, lastActivityMs };

  const match = CLOSE_WARNING_DEADLINE_PATTERN.exec(message.content);
  return {
    message,
    alreadyArchived: false,
    deadlineMs: match ? Number(match[1]) * 1000 : undefined,
    lastActivityMs,
  };
}

// Archives and locks the thread, then rewrites the close marker to record
// when that happened. Archive and lock go in one edit so a message cannot
// land between them and reopen the thread. Locking needs Manage Threads;
// if the combined edit is refused, archive alone. Safe to call repeatedly.
async function closeThread(thread: ThreadChannel, marker: CloseMarker | undefined): Promise<void> {
  const archived = await thread
    .edit({ archived: true, locked: true })
    .then(() => true)
    .catch(async (err) => {
      console.error(`Failed to archive+lock thread ${thread.id}, trying archive alone:`, err);
      return thread
        .setArchived(true)
        .then(() => true)
        .catch((fallbackErr) => {
          console.error(`Failed to archive thread ${thread.id}:`, fallbackErr);
          return false;
        });
    });
  if (!archived || !marker || marker.alreadyArchived) return;
  await marker.message.edit(`${CLOSE_ARCHIVED_PREFIX} <t:${Math.floor(Date.now() / 1000)}:D>.`).catch(() => {});
}

// Runs reconcileClose() at `atMs`. The marker is re-read at that point rather
// than trusted from when the timer was armed, since the deadline may have
// moved; a missing marker is left for the sweep.
function armCloseTimer(thread: ThreadChannel, atMs: number): void {
  setTimeout(
    () => {
      findCloseMarker(thread)
        .then((marker) => (marker ? reconcileClose(thread, marker) : undefined))
        .catch((err) => console.error(`Failed to close thread ${thread.id} on schedule:`, err));
    },
    Math.max(0, atMs - Date.now()),
  );
}

// Posts the close warning and arms the timer for it.
export async function scheduleClose(thread: ThreadChannel): Promise<void> {
  const deadlineMs = Date.now() + THREAD_CLOSE_DELAY_MS;
  await thread.send(warningText(deadlineMs)).catch(() => {});
  armCloseTimer(thread, deadlineMs);
}

// When the thread should close: 24h after its most recent message, or the
// deadline its warning already shows, whichever is later. Ongoing discussion
// keeps pushing the close out, and a reopened thread gets a fresh 24h.
function closeDueAt(marker: CloseMarker): number {
  const fromActivity = marker.lastActivityMs + THREAD_CLOSE_DELAY_MS;
  return marker.deadlineMs === undefined ? fromActivity : Math.max(marker.deadlineMs, fromActivity);
}

// Closes the thread if due; otherwise rewrites the marker in place when its
// deadline has moved (or it still reads "was archived" after a reopen) and
// re-arms the timer. Shared by the close timer and the sweep.
export async function reconcileClose(thread: ThreadChannel, marker: CloseMarker): Promise<void> {
  const dueAt = closeDueAt(marker);
  if (Date.now() >= dueAt) {
    await closeThread(thread, marker);
    return;
  }
  const shown = marker.alreadyArchived ? undefined : marker.deadlineMs;
  if (shown !== undefined && Math.abs(dueAt - shown) <= CLOSE_DEADLINE_SLOP_MS) return;
  await marker.message.edit(warningText(dueAt)).catch(() => {});
  armCloseTimer(thread, dueAt);
}
