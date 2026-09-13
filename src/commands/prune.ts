import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  TextChannel,
  ThreadChannel,
  Message,
  MessageFlags,
} from 'discord.js';
import { wouldGameNoticeBeAllowed, isTrackedSeekMessage } from '../playtak/announcer';
import { isTrackedGameMessage } from '../playtak/seekToGame';
import { isGameActivelyWatched, getWatchedThread, parseThreadName } from '../playtak/watcher';
import { areRatingsLoaded } from '../playtak/ratings';
import { parseReplayThreadName } from '../playtak/catchup';
import { loadAnnounceState } from '../playtak/announceStore';
import {
  parseNotice,
  isThreadStarterMessage,
  deleteThread,
  deleteMessages,
  STALE_AGE_MS,
  isGameStillLive,
  collectChannelThreads,
  mapThreadsByGameNo,
  threadHasHumanMessages,
  MAX_MESSAGE_PAGES,
  MESSAGE_PAGE_SIZE,
} from '../playtak/pruneRules';

export const data = new SlashCommandBuilder()
  .setName('prune')
  .setDescription("Clean up old bot messages/threads that no longer match this channel's current rules")
  .addSubcommand((sub) =>
    sub.setName('duplicates').setDescription('Collapse duplicate watch threads for the same game (skips ones with human chat)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('threads')
      .setDescription('Remove stale/rule-mismatched watch threads (live games untouched)'),
  )
  .addSubcommand((sub) =>
    sub.setName('messages').setDescription('Remove stale/rule-mismatched channel messages'),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

// Commands whose replies are ephemeral. Any public reply to one of these
// found in channel history predates that and is stale. /announce and /watch
// are excluded: their replies are public by design.
const NOW_EPHEMERAL_COMMANDS = new Set(['ping', 'list', 'seeks', 'help', 'showbots', 'rating', 'prune', 'expand']);

// Fallback shape matching for the oldest replies, in case the recorded
// command name is missing.
const PING_REPLY_PATTERN = /^Pong! Latency: \d+ms$/;
const EMPTY_GAMES_REPLY = 'No active games on PlayTak right now.';
const EMPTY_SEEKS_REPLY = 'No open seeks on PlayTak right now.';
const GAMES_REPLY_LINE_PATTERN = /^#\d+ - \*\*.+\*\* vs \*\*.+\*\* \(\d+x\d+, \d+\+\d+, (?:rated|unrated)\)/;
const SEEKS_REPLY_LINE_PATTERN = /^\*\*.+\*\* - \d+x\d+, \d+\+\d+, (?:either color|white|black), (?:rated|unrated)$/;

function isStaleEphemeralReply(message: Message): boolean {
  // `message.interaction` is deprecated in discord.js, but its replacement
  // (`interactionMetadata`) does not carry the command name. The recorded
  // name includes the subcommand ("prune messages"), hence the split.
  const commandName = message.interaction?.commandName.split(' ', 1)[0];
  if (commandName !== undefined && NOW_EPHEMERAL_COMMANDS.has(commandName)) return true;

  const content = message.content;
  if (content === EMPTY_GAMES_REPLY || content === EMPTY_SEEKS_REPLY) return true;
  if (PING_REPLY_PATTERN.test(content)) return true;
  const firstLine = content.split('\n', 1)[0];
  return GAMES_REPLY_LINE_PATTERN.test(firstLine) || SEEKS_REPLY_LINE_PATTERN.test(firstLine);
}

// `totalMessageSent` is the uncapped count; `messageCount` stops at 50 and
// is only a fallback for threads Discord has not backfilled.
function threadMessageCount(thread: ThreadChannel): number {
  return thread.totalMessageSent ?? thread.messageCount ?? 0;
}

// Defers ephemerally, posts a progress heartbeat every 60s (individual
// deletion can take minutes), and guards every reply so an expired
// interaction token cannot throw after the work is done.
async function runWithProgress(
  interaction: ChatInputCommandInteraction,
  progressText: () => string,
  work: () => Promise<string>,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const timer = setInterval(() => {
    interaction.editReply(progressText()).catch(() => {});
  }, 60_000);

  let summary: string;
  try {
    summary = await work();
  } catch (err) {
    console.error('Error while running /prune (any deletions made before the error still happened):', err);
    clearInterval(timer);
    await interaction
      .editReply(`Hit an error partway through - ${progressText()} Check the bot's logs for details.`)
      .catch(() => {});
    return;
  } finally {
    clearInterval(timer);
  }

  await interaction.editReply(summary).catch((err) => {
    console.error('Failed to post /prune summary (the work itself still completed):', err);
  });
}

async function pruneMessages(interaction: ChatInputCommandInteraction, channel: TextChannel): Promise<void> {
  const channelId = channel.id;
  const botId = interaction.client.user?.id;
  const stats = { scanned: 0, removed: 0, removedOrphaned: 0, orphanCheckSkipped: false };

  await runWithProgress(
    interaction,
    () => `Working on pruning messages... scanned ${stats.scanned}, removed ${stats.removed} so far.`,
    async () => {
      const { threads: channelThreads, complete: threadScanComplete } = await collectChannelThreads(channel);
      stats.orphanCheckSkipped = !threadScanComplete;
      const threadGameNumbers = new Set(mapThreadsByGameNo(channelThreads, botId).keys());
      const threadIds = new Set(channelThreads.map((thread) => thread.id));
      // The one /announce reply that is kept: the live "now on" banner.
      const trackedConfirmationId = loadAnnounceState()[channelId]?.confirmationMessageId;

      let beforeId: string | undefined;

      for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
        const batch = await channel.messages.fetch({ limit: MESSAGE_PAGE_SIZE, before: beforeId }).catch(() => null);
        if (!batch || batch.size === 0) break;
        stats.scanned += batch.size;

        // Deleted together at the end of each page (one bulk call).
        // `orphanedIds` only feeds the summary breakdown.
        const doomed: Message[] = [];
        const orphanedIds = new Set<string>();

        for (const message of batch.values()) {
          if (message.author.id !== botId) continue;

          if (isStaleEphemeralReply(message)) {
            doomed.push(message);
            continue;
          }

          const commandName = message.interaction?.commandName.split(' ', 1)[0];

          // A /watch "Spectate: <#thread>" reply whose thread is gone renders
          // as "#unknown".
          if (commandName === 'watch' || commandName === 'spectate') {
            const linkedThreadId = /<#(\d+)>/.exec(message.content)?.[1];
            const orphanedLink =
              linkedThreadId !== undefined &&
              threadScanComplete &&
              Date.now() - message.createdTimestamp > STALE_AGE_MS &&
              !threadIds.has(linkedThreadId);
            if (orphanedLink) {
              doomed.push(message);
              orphanedIds.add(message.id);
            }
            continue;
          }

          // Every /announce reply except the tracked banner. Day-old, so a
          // banner posted during this scan is not caught.
          if (commandName === 'announce') {
            const outdated = message.id !== trackedConfirmationId && Date.now() - message.createdTimestamp > STALE_AGE_MS;
            if (outdated) doomed.push(message);
            continue;
          }

          // "Started a thread" line whose thread no longer exists.
          if (isThreadStarterMessage(message, botId)) {
            const orphanedStarter =
              threadScanComplete && Date.now() - message.createdTimestamp > STALE_AGE_MS && !threadIds.has(message.id);
            if (orphanedStarter) {
              doomed.push(message);
              orphanedIds.add(message.id);
            }
            continue;
          }

          const notice = parseNotice(message);
          if (!notice) continue;
          const { white, black, gameNo } = notice;

          if (isTrackedSeekMessage(channelId, message.id) || isTrackedGameMessage(message.id)) continue;

          const ruleMismatch = !wouldGameNoticeBeAllowed(channelId, white, black);
          // An incomplete thread scan cannot prove a thread is absent, so the
          // orphan check is off for the whole run in that case.
          const orphaned =
            threadScanComplete &&
            Date.now() - message.createdTimestamp > STALE_AGE_MS &&
            !threadGameNumbers.has(gameNo) &&
            !isGameStillLive(gameNo);

          if (!ruleMismatch && !orphaned) continue;

          doomed.push(message);
          if (orphaned) orphanedIds.add(message.id);
        }

        // Read before deleting: a deleted id still works as a paging cursor.
        beforeId = batch.last()?.id;

        const deletedIds = await deleteMessages(channel, doomed);
        stats.removed += deletedIds.length;
        stats.removedOrphaned += deletedIds.filter((id) => orphanedIds.has(id)).length;

        if (batch.size < MESSAGE_PAGE_SIZE) break;
      }

      const orphanLine = stats.orphanCheckSkipped
        ? ' (Skipped checking for notices with a missing thread this run - this channel has more archived threads ' +
          "than one pass covers, so a thread's absence couldn't be confirmed safely.)"
        : stats.removedOrphaned > 0
          ? ` ${stats.removedOrphaned} of those were game notices, "started a thread" lines, or /watch links whose ` +
            'thread could no longer be found, over a day old.'
          : '';
      return (
        `Scanned ${stats.scanned} message${stats.scanned === 1 ? '' : 's'}, removed ${stats.removed} that wouldn't ` +
        "be posted here now (game notices no longer matching this channel's rules, old public replies from " +
        `commands that now reply privately, and outdated /announce status replies).${orphanLine}`
      );
    },
  );
}

async function pruneThreads(interaction: ChatInputCommandInteraction, channel: TextChannel): Promise<void> {
  const channelId = channel.id;
  const botId = interaction.client.user?.id;
  const stats = { scanned: 0, removed: 0, removedWithHumans: [] as string[], removedStale: 0 };

  await runWithProgress(
    interaction,
    () => `Working on pruning threads... scanned ${stats.scanned}, removed ${stats.removed} so far.`,
    async () => {
      const { threads: candidates } = await collectChannelThreads(channel);

      for (const thread of candidates) {
        stats.scanned++;
        if (thread.ownerId !== botId) continue;

        // Watch threads and replay threads alike.
        const parsed = parseThreadName(thread.name) ?? parseReplayThreadName(thread.name);
        if (!parsed) continue;

        if (isGameStillLive(parsed.gameNo)) continue;

        const ruleMismatch = !wouldGameNoticeBeAllowed(channelId, parsed.white, parsed.black);
        const oldEnough = Date.now() - (thread.createdTimestamp ?? Date.now()) > STALE_AGE_MS;

        // Only fetched when it can affect the outcome or the summary. Only a
        // definite false makes a thread stale.
        let hadHumans: boolean | undefined;
        if (ruleMismatch || oldEnough) hadHumans = await threadHasHumanMessages(thread);

        const isStale = oldEnough && hadHumans === false;
        if (!ruleMismatch && !isStale) continue;

        // A rule-mismatched thread with human chat is still removed; the
        // summary reports it.
        if (!(await deleteThread(thread))) continue;
        stats.removed++;
        if (ruleMismatch) {
          if (hadHumans) stats.removedWithHumans.push(thread.name);
        } else {
          stats.removedStale++;
        }
      }

      const flagLine =
        stats.removedWithHumans.length > 0
          ? ` ${stats.removedWithHumans.length} of those had human messages in them: ${stats.removedWithHumans.join(', ')}.`
          : '';
      const staleLine =
        stats.removedStale > 0
          ? ` Also removed ${stats.removedStale} more that had no human messages and were over a day old (regardless ` +
            "of whether they'd currently match this channel's rules)."
          : '';
      return (
        `Scanned ${stats.scanned} thread${stats.scanned === 1 ? '' : 's'}, removed ${stats.removed} that wouldn't ` +
        `be shown here now (live games are never touched).${flagLine}${staleLine}`
      );
    },
  );
}

async function pruneDuplicates(interaction: ChatInputCommandInteraction, channel: TextChannel): Promise<void> {
  const botId = interaction.client.user?.id;
  const stats = { scanned: 0, removed: 0, skippedGroups: [] as string[] };

  await runWithProgress(
    interaction,
    () => `Working on pruning duplicate threads... scanned ${stats.scanned}, removed ${stats.removed} so far.`,
    async () => {
      const { threads: candidates } = await collectChannelThreads(channel);
      stats.scanned = candidates.length;

      const byGameNo = new Map<number, ThreadChannel[]>();
      for (const thread of candidates) {
        if (thread.ownerId !== botId) continue;
        const parsed = parseThreadName(thread.name);
        if (!parsed) continue;
        const group = byGameNo.get(parsed.gameNo);
        if (group) group.push(thread);
        else byGameNo.set(parsed.gameNo, [thread]);
      }

      for (const [gameNo, threads] of byGameNo) {
        if (threads.length < 2) continue;

        // If any duplicate has human chat, or could not be checked, the
        // whole group is left alone and reported.
        const humanFlags = await Promise.all(threads.map((t) => threadHasHumanMessages(t)));
        if (humanFlags.some((flag) => flag !== false)) {
          stats.skippedGroups.push(`#${gameNo} (${threads.length} threads: ${threads.map((t) => `${t}`).join(', ')})`);
          continue;
        }

        const liveThread = isGameActivelyWatched(gameNo) ? getWatchedThread(gameNo) : undefined;
        const keeper =
          (liveThread && threads.find((t) => t.id === liveThread.id)) ??
          threads.reduce((best, t) => (threadMessageCount(t) > threadMessageCount(best) ? t : best));

        for (const thread of threads) {
          if (thread.id === keeper.id) continue;
          if (await deleteThread(thread)) stats.removed++;
        }
      }

      const skippedLine =
        stats.skippedGroups.length > 0
          ? ` Left ${stats.skippedGroups.length} duplicate group(s) alone because people were talking in them: ${stats.skippedGroups.join('; ')}.`
          : '';
      return (
        `Scanned ${stats.scanned} thread${stats.scanned === 1 ? '' : 's'}, removed ${stats.removed} duplicate` +
        `${stats.removed === 1 ? '' : 's'}.${skippedLine}`
      );
    },
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!(interaction.channel instanceof TextChannel)) {
    await interaction.reply({ content: 'This only works in a text channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  // A /rating rule cannot be evaluated until the ratings list has loaded,
  // and evaluating it with every rating unknown would hide everything the
  // rule gates. Deletion is irreversible, so refuse until then.
  if (!areRatingsLoaded()) {
    await interaction.reply({
      content:
        "PlayTak's rating list hasn't finished loading since the bot last restarted, so /rating rules can't be " +
        'checked yet - running /prune right now could delete things a rating rule should protect. Wait a ' +
        'minute or two and try again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel;

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'duplicates') {
    await pruneDuplicates(interaction, channel);
  } else if (subcommand === 'threads') {
    await pruneThreads(interaction, channel);
  } else {
    await pruneMessages(interaction, channel);
  }
}
