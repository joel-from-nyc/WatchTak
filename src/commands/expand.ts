import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  TextChannel,
  AnyThreadChannel,
  AttachmentBuilder,
  Message,
} from 'discord.js';
import { parseThreadName, getActiveWatchSnapshot, attachMirrorThread } from '../playtak/watcher';
import { getGameRegistry } from '../playtak/shared';
import { fetchArchivedGame } from '../playtak/gameArchive';
import { renderBoardPng } from '../playtak/boardImage';
import { plyToMoveLabel } from '../playtak/ptn';
import {
  parseChunkHeader,
  filledChunkContent,
  markChunkStale,
  expectedChunkMoveList,
  moveOnlyText,
  STALE_CHUNK_NOTE,
  replayThreadName,
  parseReplayThreadName,
} from '../playtak/catchup';
import { codeBlock } from '../playtak/format';
import { describeResult } from '../playtak/result';
import { buildPtnNinjaLink } from '../playtak/ptnLink';

export const data = new SlashCommandBuilder()
  .setName('expand')
  .setDescription("Draw the boards a game thread's catch-up summaries skipped, in place or in a new replay thread")
  .addSubcommand((sub) =>
    sub.setName('here').setDescription("Draw the missing boards onto this thread's catch-up summaries, editing them in place"),
  )
  .addSubcommand((sub) =>
    sub.setName('new').setDescription('Build a replay thread with every move and board of this game, then follow it live'),
  );

// Pages of thread messages to scan for unfilled chunk summaries.
const MAX_CHUNK_SCAN_PAGES = 20;

// /expand new refuses games longer than this; the ptn.ninja link covers them.
const REPLAY_MAX_PLIES = 150;

// A game's move record: the live watch state, or the archive for a finished
// game. `komi` is in real points (wire half-points already divided).
interface GameRecord {
  plies: string[];
  boardSize: number;
  komi: number;
  white: string;
  black: string;
  live: boolean;
  result?: string;
}

// Sends nothing to PlayTak: reads the watcher's buffer or the public archive.
async function resolveGameRecord(gameNo: number): Promise<{ record: GameRecord } | { error: string }> {
  const snapshot = getActiveWatchSnapshot(gameNo);
  if (snapshot) {
    if (!snapshot.live) return { error: "Still syncing this game's history - try again in a few seconds." };
    return { record: { ...snapshot } };
  }

  // Live but not yet re-adopted by the sweep after a restart.
  if (getGameRegistry().find(gameNo)) {
    return {
      error: "I'm not tracking this game's moves right now - the thread resyncs automatically. Try again in a minute.",
    };
  }

  const archived = await fetchArchivedGame(gameNo);
  if (archived) {
    return {
      record: {
        plies: archived.plies,
        boardSize: archived.boardSize,
        komi: archived.komi / 2,
        white: archived.white,
        black: archived.black,
        live: false,
        result: archived.result,
      },
    };
  }

  return { error: "Couldn't find a record of this game. If it just ended, the archive may need a minute - try again shortly." };
}

// One /expand at a time per game.
const inFlightExpands = new Set<number>();

export async function execute(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;
  const botId = interaction.client.user?.id;
  const parsed = channel?.isThread() && channel.ownerId === botId ? parseThreadName(channel.name) : undefined;
  if (!channel?.isThread() || !parsed) {
    await interaction.reply({
      content: 'This command only works inside one of my game threads.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (inFlightExpands.has(parsed.gameNo)) {
    await interaction.reply({
      content: 'An expand is already running for this game - wait for it to finish.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  inFlightExpands.add(parsed.gameNo);
  try {
    if (interaction.options.getSubcommand() === 'here') {
      await expandHere(interaction, channel, parsed.gameNo);
    } else {
      await expandNew(interaction, channel, parsed.gameNo);
    }
  } finally {
    inFlightExpands.delete(parsed.gameNo);
  }
}

// Edits one board image per ply onto every unfilled chunk summary in the
// thread. Attachments are in ply order and each highlights its own move.
async function expandHere(interaction: ChatInputCommandInteraction, thread: AnyThreadChannel, gameNo: number): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const resolved = await resolveGameRecord(gameNo);
  if ('error' in resolved) {
    await interaction.editReply(resolved.error);
    return;
  }
  const { plies, boardSize, komi, white, black } = resolved.record;

  const botId = interaction.client.user?.id;
  const chunks: { message: Message; fromPly: number; toPly: number }[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_CHUNK_SCAN_PAGES; page++) {
    const batch = await thread.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    for (const message of batch.values()) {
      if (message.author.id !== botId) continue;
      // Already filled, or already marked stale by a previous run.
      if (message.attachments.size > 0) continue;
      if (message.content.includes(STALE_CHUNK_NOTE)) continue;
      const range = parseChunkHeader(message.content);
      if (range) chunks.push({ message, ...range });
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  if (chunks.length === 0) {
    await interaction.editReply('Nothing to expand here - every catch-up summary already has boards (or there are none).');
    return;
  }

  chunks.sort((a, b) => a.fromPly - b.fromPly);

  let filled = 0;
  let boards = 0;
  const skipped: string[] = [];
  for (const { message, fromPly, toPly } of chunks) {
    // If a takeback rewrote the moves this chunk lists, its boards would be
    // wrong: mark it stale instead.
    const rewritten = toPly >= plies.length || !message.content.includes(expectedChunkMoveList(plies, fromPly, toPly));
    if (rewritten) {
      await message.edit(markChunkStale(message.content)).catch(() => {});
      skipped.push(`${plyToMoveLabel(fromPly)}-${plyToMoveLabel(toPly)}`);
      continue;
    }

    const files: AttachmentBuilder[] = [];
    for (let k = fromPly; k <= toPly; k++) {
      const png = renderBoardPng(boardSize, komi, plies.slice(0, k + 1), white, black);
      files.push(new AttachmentBuilder(png, { name: `board-${plyToMoveLabel(k)}.png` }));
    }
    const ok = await message
      .edit({ content: filledChunkContent(plies, fromPly, toPly), files })
      .then(() => true)
      .catch((err) => {
        console.error(`Failed to fill catch-up chunk in thread ${thread.id} (game #${gameNo}):`, err);
        return false;
      });
    if (ok) {
      filled++;
      boards += files.length;
    }
  }

  const parts: string[] = [];
  if (filled > 0) {
    parts.push(`Drew ${boards} board${boards === 1 ? '' : 's'} onto ${filled} catch-up summar${filled === 1 ? 'y' : 'ies'}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped moves ${skipped.join(', ')} - a takeback rewrote them after their summary was posted.`);
  }
  if (parts.length === 0) parts.push("Couldn't fill any summaries - check the bot's logs.");
  await interaction.editReply(parts.join(' '));
}

// Builds a replay thread with one message and board per move, then attaches
// it as the watch's live mirror if the game is still in progress. Replies
// publicly, since the link is useful to everyone in the thread.
async function expandNew(interaction: ChatInputCommandInteraction, thread: AnyThreadChannel, gameNo: number): Promise<void> {
  await interaction.deferReply();
  // Failures replace the public placeholder with a private message.
  const fail = async (content: string) => {
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  };

  const resolved = await resolveGameRecord(gameNo);
  if ('error' in resolved) {
    await fail(resolved.error);
    return;
  }
  const record = resolved.record;
  const { boardSize, komi, white, black } = record;

  if (record.plies.length === 0) {
    await fail('No moves to replay yet.');
    return;
  }
  if (record.plies.length > REPLAY_MAX_PLIES) {
    await fail(
      `That's ${record.plies.length} moves - too long for a message-per-move replay (the cap is ${REPLAY_MAX_PLIES}). ` +
        'Use the ptn.ninja link for an interactive replay instead.',
    );
    return;
  }

  // Threads cannot nest; the replay is created in the parent channel.
  const parent = thread.parent;
  if (!(parent instanceof TextChannel)) {
    await fail("Couldn't find the text channel this thread belongs to.");
    return;
  }

  const botId = interaction.client.user?.id;
  const active = await parent.threads.fetchActive().catch(() => null);
  for (const existing of active?.threads.values() ?? []) {
    if (existing.ownerId !== botId) continue;
    if (parseReplayThreadName(existing.name)?.gameNo === gameNo) {
      await fail(`This game already has a replay thread: ${existing}`);
      return;
    }
  }

  const replayThread = await parent.threads.create({
    name: replayThreadName(white, black, gameNo),
    autoArchiveDuration: 1440,
  });

  await interaction.editReply(`Building a replay thread (${record.plies.length} move${record.plies.length === 1 ? '' : 's'} so far): ${replayThread}`);

  await replayThread
    .send(
      `${codeBlock([
        `Replay of ${white} vs ${black} (game #${gameNo})`,
        record.live
          ? 'Live moves will follow here once the replay catches up.'
          : 'This game is finished - the full replay follows.',
      ])}\nGame thread: ${thread}`,
    )
    .catch(() => {});

  // Sends are sequential; discord.js queues the channel rate limit.
  const postedPlies: string[] = [];
  try {
    while (true) {
      let current = record.plies;
      if (record.live) {
        const snapshot = getActiveWatchSnapshot(gameNo);
        if (!snapshot) {
          await replayThread.send(
            `${codeBlock(['The game ended while this replay was being built.'])}\nSee the game thread for the result: ${thread}`,
          );
          return;
        }
        // Mid-resync after a disconnect: wait for the plies to settle.
        if (!snapshot.live) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        current = snapshot.plies;
      }

      // A takeback during the build rewrites posted plies: stop.
      const stillMatches =
        current.length >= postedPlies.length && postedPlies.every((ptn, i) => current[i] === ptn);
      if (!stillMatches) {
        await replayThread.send(
          `${codeBlock(['A move was taken back while this replay was being built - stopping here.'])}\nFollow the game thread instead: ${thread}`,
        );
        return;
      }

      if (postedPlies.length >= current.length) break;

      const k = postedPlies.length;
      const png = renderBoardPng(boardSize, komi, current.slice(0, k + 1), white, black);
      await replayThread.send({
        content: moveOnlyText(k, current[k]),
        files: [new AttachmentBuilder(png, { name: 'board.png' })],
      });
      postedPlies.push(current[k]);
    }

    if (record.live) {
      // The mirror is attached only once fully caught up, so no move is
      // dropped or double-posted across the handoff.
      if (attachMirrorThread(gameNo, replayThread)) {
        await replayThread.send(codeBlock(['Caught up - now following the live game.']));
      } else {
        await replayThread.send(
          `${codeBlock(['Caught up - but the game is no longer being tracked live.'])}\nSee the game thread: ${thread}`,
        );
      }
    } else {
      const ptnLink = buildPtnNinjaLink(gameNo);
      await replayThread.send(
        `${codeBlock(['Game Over', '', describeResult(record.result ?? '', white, black)])}\n` +
          `[View full game on ptn.ninja](${ptnLink})`,
      );
    }
  } catch (err) {
    console.error(`Replay thread build failed for game #${gameNo}:`, err);
    await replayThread
      .send(`${codeBlock(['Replay stopped early - something went wrong.'])}\nFollow the game thread instead: ${thread}`)
      .catch(() => {});
  }
}
