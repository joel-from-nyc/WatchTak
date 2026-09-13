import { Client, ThreadChannel, Message, DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { PlaytakClient } from './client';
import { loadAnnounceState } from './announceStore';
import { fetchTextChannel, isTrackedSeekMessage } from './announcer';
import { isTrackedGameMessage } from './seekToGame';
import {
  parseNotice,
  isThreadStarterMessage,
  deleteThread,
  STALE_AGE_MS,
  isGameStillLive,
  collectChannelThreads,
  deleteMessages,
  mapThreadsByGameNo,
  listReplayThreads,
  threadHasHumanMessages,
  MAX_MESSAGE_PAGES,
  MESSAGE_PAGE_SIZE,
} from './pruneRules';

const AUTO_PRUNE_INTERVAL_MS = 30 * 60 * 1000;

// Lets the post-connect GameList replay land before the first pass, so
// isGameStillLive() has a populated registry to check.
const STARTUP_DELAY_MS = 10_000;

// Threads known to contain human messages. Nothing here deletes individual
// messages, so once true this never changes and need not be re-scanned.
const threadsWithHumans = new Set<string>();

async function hasHumanMessages(thread: ThreadChannel): Promise<boolean | undefined> {
  if (threadsWithHumans.has(thread.id)) return true;
  const found = await threadHasHumanMessages(thread);
  if (found) threadsWithHumans.add(thread.id);
  return found;
}

// A message already deleted by someone else is the intended outcome, not an
// error.
async function deleteQuietly(message: Message, what: string): Promise<void> {
  await message.delete().catch((err) => {
    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) return;
    console.error(`Auto-prune: failed to delete ${what} in channel ${message.channelId}:`, err);
  });
}

// Removes, silently, a day-old game notice that nobody engaged with: one
// with no thread, or one whose thread has no human messages (the thread goes
// too). Unlike /prune, this never re-checks notices against the channel's
// current settings and never posts anything.
async function autoPruneChannel(discordClient: Client, channelId: string): Promise<void> {
  const channel = await fetchTextChannel(discordClient, channelId);
  if (!channel) return;

  const botId = discordClient.user?.id;
  const { threads, complete } = await collectChannelThreads(channel);
  // An incomplete thread scan cannot prove a thread is absent.
  if (!complete) return;
  const threadsByGameNo = mapThreadsByGameNo(threads, botId);
  const threadIds = new Set(threads.map((thread) => thread.id));

  let beforeId: string | undefined;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const batch = await channel.messages.fetch({ limit: MESSAGE_PAGE_SIZE, before: beforeId }).catch(() => null);
    if (!batch || batch.size === 0) break;

    // Standalone removals are batched per page. A notice paired with a
    // thread is deleted only after its thread is.
    const doomed: Message[] = [];

    for (const message of batch.values()) {
      if (message.author.id !== botId) continue;
      if (Date.now() - message.createdTimestamp <= STALE_AGE_MS) continue;

      // "Started a thread" line whose thread no longer exists.
      if (isThreadStarterMessage(message, botId)) {
        if (!threadIds.has(message.id)) doomed.push(message);
        continue;
      }

      const notice = parseNotice(message);
      if (!notice) continue;

      if (isTrackedSeekMessage(channelId, message.id) || isTrackedGameMessage(message.id)) continue;
      if (isGameStillLive(notice.gameNo)) continue;

      const thread = threadsByGameNo.get(notice.gameNo);
      if (!thread) {
        doomed.push(message);
        continue;
      }

      // The thread itself must be a day old too, so this never removes a
      // thread the watcher still has a pending close timer on.
      if (Date.now() - (thread.createdTimestamp ?? Date.now()) <= STALE_AGE_MS) continue;

      // Only a definite "no humans" clears the thread; undefined does not.
      if ((await hasHumanMessages(thread)) !== false) continue;

      if (!(await deleteThread(thread))) continue;
      await deleteQuietly(message, `notice for game #${notice.gameNo}`);
    }

    // Read before deleting: a deleted id still works as a paging cursor.
    beforeId = batch.last()?.id;
    await deleteMessages(channel, doomed);

    if (batch.size < MESSAGE_PAGE_SIZE) break;
  }

  // Replay threads have no notice, so they get the same rule directly.
  for (const { thread, gameNo } of listReplayThreads(threads, botId)) {
    if (isGameStillLive(gameNo)) continue;
    if (Date.now() - (thread.createdTimestamp ?? Date.now()) <= STALE_AGE_MS) continue;
    if ((await hasHumanMessages(thread)) !== false) continue;
    await deleteThread(thread);
  }
}

// Every channel with /announce configured, read from the persisted store so
// this does not depend on resumeAnnouncing() having run yet.
async function runAutoPrune(discordClient: Client): Promise<void> {
  for (const channelId of Object.keys(loadAnnounceState())) {
    await autoPruneChannel(discordClient, channelId).catch((err) => {
      console.error(`Auto-prune failed for channel ${channelId}:`, err);
    });
  }
}

export function registerAutoPrune(playtak: PlaytakClient, discordClient: Client): void {
  playtak.once('connected', () => {
    setTimeout(() => {
      const run = () => runAutoPrune(discordClient).catch((err) => console.error('Auto-prune run failed:', err));
      run();
      setInterval(run, AUTO_PRUNE_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  });
}
