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
  mapThreadsByGameNo,
  threadHasHumanMessages,
  MAX_MESSAGE_PAGES,
  MESSAGE_PAGE_SIZE,
} from './pruneRules';

// How often the silent sweep re-checks every announcing channel. The
// staleness threshold itself is a full day (see pruneRules.ts's
// STALE_AGE_MS), so this only needs to be frequent enough that a message
// doesn't sit stale for long after crossing that line - a much looser
// cadence than watcher.ts's own 15-minute thread-lifecycle sweep, since this
// one pays for a full channel-message scan on every pass.
const AUTO_PRUNE_INTERVAL_MS = 30 * 60 * 1000;

// Give the post-(re)connect GameList/seek replay a moment to land before the
// very first pass, so a fresh restart doesn't judge "is this game still
// live" (isGameStillLive()) against a registry that hasn't been repopulated
// yet.
const STARTUP_DELAY_MS = 10_000;

// Threads already confirmed to have human messages in them. Nothing here
// ever deletes individual messages, so a thread that has them keeps them,
// and once known this never needs re-checking. Without this, every stale
// notice whose thread is being kept for its conversation would cost a fresh
// message-history scan on every pass, forever, growing with every game the
// channel ever discussed.
const threadsWithHumans = new Set<string>();

async function hasHumanMessages(thread: ThreadChannel): Promise<boolean | undefined> {
  if (threadsWithHumans.has(thread.id)) return true;
  const found = await threadHasHumanMessages(thread);
  if (found) threadsWithHumans.add(thread.id);
  return found;
}

// A message that's already gone by the time this gets to it - someone ran
// /prune messages at the same moment, or deleted it by hand - is the
// outcome this wanted anyway, not a failure worth logging.
async function deleteQuietly(message: Message, what: string): Promise<void> {
  await message.delete().catch((err) => {
    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage) return;
    console.error(`Auto-prune: failed to delete ${what} in channel ${message.channelId}:`, err);
  });
}

// Implements exactly what a channel moderator asked for: a day after a
// game-started/finished notice is posted, if nobody ever actually watched
// along - no thread was ever created for it, or one was but nobody chatted
// in it - quietly remove it. Unlike the manual /prune command, this never
// posts anything about what it did (no progress message, no summary), and it
// never re-evaluates a notice against the channel's *current* /announce,
// /showbots, or /rating settings - that's what /prune itself is for. This
// only ever removes things that were simply never engaged with, silently,
// which is exactly the "keep the channel clean without adding noise of its
// own" behavior that was asked for.
async function autoPruneChannel(discordClient: Client, channelId: string): Promise<void> {
  const channel = await fetchTextChannel(discordClient, channelId);
  if (!channel) return;

  const botId = discordClient.user?.id;
  const { threads, complete } = await collectChannelThreads(channel);
  // A truncated thread scan can only be trusted to say "found", never "not
  // found" (the real thread could just be past the page cap) - see
  // collectChannelThreads(). Skip this channel entirely this pass rather
  // than risk deleting a notice whose thread genuinely still exists.
  if (!complete) return;
  const threadsByGameNo = mapThreadsByGameNo(threads, botId);
  const threadIds = new Set(threads.map((thread) => thread.id));

  let beforeId: string | undefined;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const batch = await channel.messages.fetch({ limit: MESSAGE_PAGE_SIZE, before: beforeId }).catch(() => null);
    if (!batch || batch.size === 0) break;

    for (const message of batch.values()) {
      if (message.author.id !== botId) continue;
      if (Date.now() - message.createdTimestamp <= STALE_AGE_MS) continue;

      // Discord's "started a thread" line for a thread that's since been
      // deleted (by /prune, or by an earlier pass here before that cleanup
      // was part of deleting a thread) - nothing left for it to point at.
      if (isThreadStarterMessage(message, botId)) {
        if (!threadIds.has(message.id)) await deleteQuietly(message, 'orphaned thread-starter line');
        continue;
      }

      const notice = parseNotice(message);
      if (!notice) continue;

      // Still mid-transition (seekToGame.ts/announcer.ts still hold a live
      // reference to this exact message), or the game's genuinely still
      // going - never touch either case, regardless of age.
      if (isTrackedSeekMessage(channelId, message.id) || isTrackedGameMessage(message.id)) continue;
      if (isGameStillLive(notice.gameNo)) continue;

      const thread = threadsByGameNo.get(notice.gameNo);
      if (!thread) {
        await deleteQuietly(message, 'orphaned notice');
        continue;
      }

      // The thread has to be over a day old in its own right, not just its
      // notice - a notice can be older than its game (a seek announcement
      // that sat open a while before being converted), and deleting a thread
      // watcher.ts still has a pending close timer on would just make that
      // timer fail noisily. Nothing is lost by waiting for a later pass.
      if (Date.now() - (thread.createdTimestamp ?? Date.now()) <= STALE_AGE_MS) continue;

      // Only a definite "nobody ever posted" clears the thread for removal -
      // "couldn't check" (undefined) is treated the same as "someone did".
      // Real conversation means both the thread and its notice are left
      // alone, permanently.
      if ((await hasHumanMessages(thread)) !== false) continue;

      // The notice only goes once its thread is actually gone - otherwise
      // the thread would be left with nothing pointing at it, and nothing
      // to ever clean it up by either, since this scan is keyed off notices.
      if (!(await deleteThread(thread))) continue;
      await deleteQuietly(message, `notice for game #${notice.gameNo}`);
    }

    beforeId = batch.last()?.id;
    if (batch.size < MESSAGE_PAGE_SIZE) break;
  }
}

// Every channel with /announce currently configured - the only channels
// seekToGame.ts posts these notices to, so it's also the complete list of
// channels worth checking. Read from the persisted store rather than the
// live `announcements` map so this doesn't depend on resumeAnnouncing()
// having already repopulated that map after a restart.
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
