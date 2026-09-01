import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, TextChannel, ThreadChannel } from 'discord.js';
import { wouldGameNoticeBeAllowed, isTrackedSeekMessage } from '../playtak/announcer';
import { isTrackedGameMessage } from '../playtak/seekToGame';
import { isGameActivelyWatched, getWatchedThread, parseThreadName } from '../playtak/watcher';
import { areRatingsLoaded } from '../playtak/ratings';

export const data = new SlashCommandBuilder()
  .setName('prune')
  .setDescription("Clean up old bot messages/threads that no longer match this channel's current rules")
  .addSubcommand((sub) =>
    sub.setName('duplicates').setDescription('Collapse duplicate watch threads for the same game (skips ones with human chat)'),
  )
  .addSubcommand((sub) =>
    sub.setName('threads').setDescription("Remove watch threads no longer matching this channel's rules (live games untouched)"),
  )
  .addSubcommand((sub) =>
    sub.setName('messages').setDescription("Remove channel messages no longer matching this channel's rules"),
  )
  // Same default as /announce, /showbots, /rating - Manage Channels.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

// Matches the first line of both notice shapes seekToGame.ts builds -
// "X vs Y (#123) has started!" / "X vs Y (#123) has finished." - loosely
// enough to survive either verb, tightly enough that nothing else in the
// channel accidentally matches. Player names never contain spaces (PlayTak
// usernames are single wire tokens), so splitting on " vs " is unambiguous.
const NOTICE_LINE_PATTERN = /^(.+?) vs (.+?) \(#\d+\) has (?:started!|finished\.)$/;

// Reverses formatPlayerBold()'s "**name**" / "**name** (rating)" shape back
// to the bare name - that function is the only place that builds this exact
// shape, so the pattern is stable.
const BOLD_NAME_PATTERN = /^\*\*(.+)\*\*(?: \(\d+\))?$/;

// /ping, /list, and /seeks now reply ephemerally (see ping.ts/list.ts/
// seeks.ts), so any surviving *public* reply from one of them predates that
// change and would never be posted publicly again - unconditionally stale,
// unlike the rule-based notices above. Matched structurally (not against
// exact copy) since /list and /seeks output is dynamic - one line per game/
// seek - but each has a distinctive, stable shape: gamesReply.ts's line is
// "#<gameNo> - **white** vs **black** (WxH, M+I, rated|unrated)" (no ratings
// - that's the announcer's format, not this one), seeksReply.ts's is
// "**player** - WxH, M+I, <color>, rated|unrated", and both have a fixed
// empty-state sentence. Checking just the first line is enough to identify
// the whole message.
const PING_REPLY_PATTERN = /^Pong! Latency: \d+ms$/;
const EMPTY_GAMES_REPLY = 'No active games on PlayTak right now.';
const EMPTY_SEEKS_REPLY = 'No open seeks on PlayTak right now.';
const GAMES_REPLY_LINE_PATTERN = /^#\d+ - \*\*.+\*\* vs \*\*.+\*\* \(\d+x\d+, \d+\+\d+, (?:rated|unrated)\)/;
const SEEKS_REPLY_LINE_PATTERN = /^\*\*.+\*\* - \d+x\d+, \d+\+\d+, (?:either color|white|black), (?:rated|unrated)$/;

function isStaleEphemeralReply(content: string): boolean {
  if (content === EMPTY_GAMES_REPLY || content === EMPTY_SEEKS_REPLY) return true;
  if (PING_REPLY_PATTERN.test(content)) return true;
  const firstLine = content.split('\n', 1)[0];
  return GAMES_REPLY_LINE_PATTERN.test(firstLine) || SEEKS_REPLY_LINE_PATTERN.test(firstLine);
}

function extractName(rawBoldName: string): string | undefined {
  return BOLD_NAME_PATTERN.exec(rawBoldName)?.[1];
}

// One command run scans at most this many messages (10 pages of Discord's own
// 100-per-fetch cap) - enough for a realistic backscroll without an
// open-ended API scan.
const MAX_MESSAGE_PAGES = 10;
const MESSAGE_PAGE_SIZE = 100;

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

// `totalMessageSent` is the uncapped lifetime count; `messageCount` stops
// incrementing past 50 and is only a fallback for a thread old enough that
// Discord hasn't backfilled the newer field.
function threadMessageCount(thread: ThreadChannel): number {
  return thread.totalMessageSent ?? thread.messageCount ?? 0;
}

// Whether any human has ever posted in this thread. `author.bot` is
// Discord's own flag for a bot/application account, so this correctly
// excludes both this bot's own move-by-move posts and anything any other bot
// might have said - only a genuine human message counts.
async function threadHasHumanMessages(thread: ThreadChannel): Promise<boolean> {
  let before: string | undefined;
  for (let page = 0; page < MAX_HUMAN_CHECK_PAGES; page++) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    for (const message of batch.values()) {
      if (!message.author.bot) return true;
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return false;
}

// This channel's own threads, active plus a bounded page of archived ones -
// shared by the duplicates and threads subcommands.
async function collectChannelThreads(channel: TextChannel): Promise<ThreadChannel[]> {
  const candidates: ThreadChannel[] = [];

  const active = await channel.threads.fetchActive().catch(() => null);
  if (active) candidates.push(...active.threads.values());

  let before: ThreadChannel | undefined;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const archived = await channel.threads.fetchArchived({ limit: THREAD_PAGE_SIZE, before }).catch(() => null);
    if (!archived || archived.threads.size === 0) break;
    candidates.push(...archived.threads.values());
    before = archived.threads.last();
    if (!archived.hasMore) break;
  }
  return candidates;
}

// Shared scaffolding for all three subcommands: defers, posts a "still
// working" heartbeat every 60s (Discord's individual, non-bulk deletion is
// throttled hard enough that a big backscroll can take many minutes - see
// the /prune run that once left "thinking..." showing for a long time), and
// guards every reply (including the final one) with .catch() so a deferred
// interaction's 15-minute webhook-token expiry can't throw an unhandled
// rejection - the work itself was never gated on the reply succeeding.
async function runWithProgress(
  interaction: ChatInputCommandInteraction,
  progressText: () => string,
  work: () => Promise<string>,
): Promise<void> {
  await interaction.deferReply();

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
  const stats = { scanned: 0, removed: 0 };

  await runWithProgress(
    interaction,
    () => `Working on pruning messages... scanned ${stats.scanned}, removed ${stats.removed} so far.`,
    async () => {
      let beforeId: string | undefined;

      for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
        const batch = await channel.messages.fetch({ limit: MESSAGE_PAGE_SIZE, before: beforeId }).catch(() => null);
        if (!batch || batch.size === 0) break;
        stats.scanned += batch.size;

        for (const message of batch.values()) {
          if (message.author.id !== botId) continue;

          if (isStaleEphemeralReply(message.content)) {
            await message.delete().catch(() => {});
            stats.removed++;
            continue;
          }

          const firstLine = message.content.split('\n', 1)[0];
          const match = NOTICE_LINE_PATTERN.exec(firstLine);
          if (!match) continue;

          const white = extractName(match[1]);
          const black = extractName(match[2]);
          if (white === undefined || black === undefined) continue;

          // Still live - leave it for the game to finish naturally rather
          // than risk deleting something announcer.ts/seekToGame.ts track.
          if (isTrackedSeekMessage(channelId, message.id) || isTrackedGameMessage(message.id)) continue;

          if (wouldGameNoticeBeAllowed(channelId, white, black)) continue;

          await message.delete().catch(() => {});
          stats.removed++;
        }

        beforeId = batch.last()?.id;
        if (batch.size < MESSAGE_PAGE_SIZE) break;
      }

      return (
        `Scanned ${stats.scanned} message${stats.scanned === 1 ? '' : 's'}, removed ${stats.removed} that wouldn't ` +
        "be posted here now (game notices no longer matching this channel's rules, and old public /ping, /list, or " +
        '/seeks replies).'
      );
    },
  );
}

async function pruneThreads(interaction: ChatInputCommandInteraction, channel: TextChannel): Promise<void> {
  const channelId = channel.id;
  const botId = interaction.client.user?.id;
  const stats = { scanned: 0, removed: 0, removedWithHumans: [] as string[] };

  await runWithProgress(
    interaction,
    () => `Working on pruning threads... scanned ${stats.scanned}, removed ${stats.removed} so far.`,
    async () => {
      const candidates = await collectChannelThreads(channel);

      for (const thread of candidates) {
        stats.scanned++;
        if (thread.ownerId !== botId) continue;

        const parsed = parseThreadName(thread.name);
        if (!parsed) continue;

        // Still being played/watched - never delete a live thread, even if
        // it no longer matches current rules.
        if (isGameActivelyWatched(parsed.gameNo)) continue;

        if (wouldGameNoticeBeAllowed(channelId, parsed.white, parsed.black)) continue;

        // Checked and reported, not skipped - unlike /prune duplicates,
        // running this subcommand is a deliberate "enforce current rules"
        // action, so it still removes the thread; this just makes sure a
        // human conversation that gets swept up isn't lost silently.
        const hadHumans = await threadHasHumanMessages(thread);
        await thread.delete().catch(() => {});
        stats.removed++;
        if (hadHumans) stats.removedWithHumans.push(thread.name);
      }

      const flagLine =
        stats.removedWithHumans.length > 0
          ? ` ${stats.removedWithHumans.length} of those had human messages in them: ${stats.removedWithHumans.join(', ')}.`
          : '';
      return (
        `Scanned ${stats.scanned} thread${stats.scanned === 1 ? '' : 's'}, removed ${stats.removed} that wouldn't ` +
        `be shown here now (live games are never touched).${flagLine}`
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
      const candidates = await collectChannelThreads(channel);
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

        // Safety: if a human ever posted in ANY of the duplicates, leave
        // every one of them alone and just report the game - guessing which
        // copy of a real conversation to keep isn't something this should
        // do on its own.
        const humanFlags = await Promise.all(threads.map((t) => threadHasHumanMessages(t)));
        if (humanFlags.some(Boolean)) {
          stats.skippedGroups.push(`#${gameNo} (${threads.length} threads: ${threads.map((t) => `${t}`).join(', ')})`);
          continue;
        }

        const liveThread = isGameActivelyWatched(gameNo) ? getWatchedThread(gameNo) : undefined;
        const keeper =
          (liveThread && threads.find((t) => t.id === liveThread.id)) ??
          threads.reduce((best, t) => (threadMessageCount(t) > threadMessageCount(best) ? t : best));

        for (const thread of threads) {
          if (thread.id === keeper.id) continue;
          await thread.delete().catch(() => {});
          stats.removed++;
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
    await interaction.reply({ content: 'This only works in a text channel.', ephemeral: true });
    return;
  }

  // Every subcommand's "would this still be shown?" check (wouldGameNoticeBeAllowed())
  // depends on PlayTak's ratings list to evaluate a /rating override - and
  // that list is empty until its first fetch completes after a restart (see
  // ratings.ts's areRatingsLoaded()). Running /prune in that window would
  // silently treat every /rating override as unset, deleting things it
  // should have protected - refusing outright is safer than a wrong answer,
  // since deletion isn't reversible.
  if (!areRatingsLoaded()) {
    await interaction.reply({
      content:
        "PlayTak's rating list hasn't finished loading since the bot last restarted, so /rating overrides can't be " +
        'checked yet - running /prune right now could delete things a rating override should protect. Wait a ' +
        'minute or two and try again.',
      ephemeral: true,
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
