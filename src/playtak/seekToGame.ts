import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import { GameListEntry, Seek } from './protocol';
import { getPlaytakClient } from './shared';
import { fetchTextChannel, listAnnouncingChannelIds, isGameNoticeAllowed, notePostOutcome } from './announcer';
import { getWatchedThread } from './watcher';
import { formatPlayerBold } from './ratings';
import { discordTime, formatDuration } from './format';
import { noteGameStarted, getGameStartedAt } from './gameTimes';

// The protocol carries no link between a seek and the game it becomes: a
// `Seek remove` looks the same whether the seek was cancelled or accepted,
// and a `GameList Add` does not reference a seek. A removal and a new game
// naming the same player within this window are treated as the same event,
// in either order.
const CORRELATION_WINDOW_MS = 5000;

// (Re)connects replay the whole active game list as `GameList Add`. Games
// arriving within this window after connect are not correlated.
const REPLAY_SETTLE_MS = 2000;

// A seek announcement the bot posted and can still edit or delete.
export interface SeekMessageRef {
  channelId: string;
  messageId: string;
}

interface PendingRemoval {
  // Kept whole: the seek's bot flag is the only bot signal for its poster.
  seek: Seek;
  // Empty for a seek that was never announced (private, or no channel on).
  refs: SeekMessageRef[];
  timer: NodeJS.Timeout;
}

interface PendingGame {
  game: GameListEntry;
  timer: NodeJS.Timeout;
}

const pendingRemovals: PendingRemoval[] = [];
const pendingGames: PendingGame[] = [];

// Live game notices by game number, with the player names so the finished
// text can be rendered without re-reading the message (discord.js's
// `MessageManager#edit()` does not update the channel's message cache).
const noticesByGame = new Map<number, { refs: SeekMessageRef[]; white: string; black: string }>();

let replayingUntil = 0;

// Whether `messageId` is the notice of a game still in progress.
export function isTrackedGameMessage(messageId: string): boolean {
  for (const notice of noticesByGame.values()) {
    if (notice.refs.some((ref) => ref.messageId === messageId)) return true;
  }
  return false;
}

function watchRow(gameNo: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`watch:${gameNo}`).setLabel('Watch game').setStyle(ButtonStyle.Primary),
  );
}

function reviewRow(gameNo: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`watch-review:${gameNo}`).setLabel('Review game').setStyle(ButtonStyle.Secondary),
  );
}

async function deleteRefs(discordClient: Client, refs: SeekMessageRef[]): Promise<void> {
  for (const ref of refs) {
    const channel = await fetchTextChannel(discordClient, ref.channelId);
    if (!channel) continue;
    await channel.messages.delete(ref.messageId).catch(() => {});
  }
}

// "X vs Y (#123) has started!" plus a viewer-local start timestamp.
function startedContent(game: GameListEntry): string {
  const headline = `${formatPlayerBold(game.white)} vs ${formatPlayerBold(game.black)} (#${game.gameNo}) has started!`;
  const startedAt = getGameStartedAt(game.gameNo);
  return startedAt === undefined ? headline : `${headline}\nStarted ${discordTime(startedAt)}`;
}

// Edits the seek's announcement into the game-started notice, reusing the
// same message slot.
async function convertToGameNotice(discordClient: Client, game: GameListEntry, refs: SeekMessageRef[]): Promise<void> {
  const content = startedContent(game);
  const landed: SeekMessageRef[] = [];

  for (const ref of refs) {
    const channel = await fetchTextChannel(discordClient, ref.channelId);
    if (!channel) continue;
    const edited = await channel.messages
      .edit(ref.messageId, { content, components: [watchRow(game.gameNo)] })
      .catch((err) => {
        console.error(`Failed to convert seek announcement in ${ref.channelId}:`, err);
        notePostOutcome(discordClient, ref.channelId, err);
        return null;
      });
    if (edited) {
      notePostOutcome(discordClient, ref.channelId, null);
      landed.push(ref);
    }
  }

  if (landed.length > 0) noticesByGame.set(game.gameNo, { refs: landed, white: game.white, black: game.black });
}

// Posts a new notice to every eligible channel, for a game with no seek
// announcement to convert (a private challenge such as a rematch).
async function postFreshGameNotice(discordClient: Client, game: GameListEntry, seek: Seek | undefined): Promise<void> {
  const content = startedContent(game);
  const landed: SeekMessageRef[] = [];

  for (const channelId of listAnnouncingChannelIds(game, seek)) {
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) continue;
    const message = await channel.send({ content, components: [watchRow(game.gameNo)] }).catch((err) => {
      console.error(`Failed to post game-started notice to ${channelId}:`, err);
      notePostOutcome(discordClient, channelId, err);
      return null;
    });
    if (message) {
      notePostOutcome(discordClient, channelId, null);
      landed.push({ channelId, messageId: message.id });
    }
  }

  if (landed.length > 0) noticesByGame.set(game.gameNo, { refs: landed, white: game.white, black: game.black });
}

// Converts the seek announcements in channels whose settings allow a notice
// for this game, deletes the rest, and posts fresh where there were none.
async function announceGame(
  discordClient: Client,
  game: GameListEntry,
  refs: SeekMessageRef[],
  seek: Seek | undefined,
): Promise<void> {
  const activeRefs = refs.filter((ref) => isGameNoticeAllowed(ref.channelId, game, seek));
  const suppressedRefs = refs.filter((ref) => !isGameNoticeAllowed(ref.channelId, game, seek));

  if (suppressedRefs.length > 0) await deleteRefs(discordClient, suppressedRefs);

  if (activeRefs.length > 0) {
    await convertToGameNotice(discordClient, game, activeRefs);
  } else if (refs.length === 0) {
    await postFreshGameNotice(discordClient, game, seek);
  }
}

// On game end: swap the Watch button for Review, rewrite the notice as
// "has finished", and delete Discord's "started a thread" line for the
// game's thread since the notice now links to it.
async function retireGameNotice(discordClient: Client, gameNo: number): Promise<void> {
  const notice = noticesByGame.get(gameNo);
  if (!notice) return;
  noticesByGame.delete(gameNo);

  const thread = getWatchedThread(gameNo);
  if (thread) {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    await starter?.delete().catch(() => {});
  }

  const endedAt = Date.now();
  const startedAt = getGameStartedAt(gameNo);
  const timeLine =
    startedAt === undefined
      ? `Ended ${discordTime(endedAt)}`
      : `Ended ${discordTime(endedAt)} · lasted ${formatDuration(endedAt - startedAt)}`;
  const content = `${formatPlayerBold(notice.white)} vs ${formatPlayerBold(notice.black)} (#${gameNo}) has finished.\n${timeLine}`;
  for (const ref of notice.refs) {
    const channel = await fetchTextChannel(discordClient, ref.channelId);
    if (!channel) continue;
    await channel.messages.edit(ref.messageId, { content, components: [reviewRow(gameNo)] }).catch(() => {});
  }
}

function dropPendingRemoval(entry: PendingRemoval): void {
  const index = pendingRemovals.indexOf(entry);
  if (index !== -1) pendingRemovals.splice(index, 1);
}

// A direct challenge between humans (e.g. a rematch). Never announced as a
// seek, but worth a game notice once accepted.
function isPrivateHumanSeek(seek: Seek): boolean {
  return seek.opponent !== '' && seek.isBot === false;
}

// A bot's public seek. Never announced as a seek, but a human accepting it
// is a game worth a notice, subject to the channel's mode.
function isBotPublicSeek(seek: Seek): boolean {
  return seek.opponent === '' && seek.isBot === true;
}

// Called when a seek disappears. If a matching game already arrived, the
// notice is posted now; otherwise the removal waits for one. If none comes
// within the window, the seek was cancelled and its announcements are deleted.
export function notifySeekRemoved(discordClient: Client, seek: Seek, refs: SeekMessageRef[]): void {
  if (refs.length === 0 && !isPrivateHumanSeek(seek) && !isBotPublicSeek(seek)) return;

  const matchIndex = pendingGames.findIndex((p) => p.game.white === seek.player || p.game.black === seek.player);
  if (matchIndex !== -1) {
    const [match] = pendingGames.splice(matchIndex, 1);
    clearTimeout(match.timer);
    announceGame(discordClient, match.game, refs, seek).catch((err) => {
      console.error('Failed to announce game start:', err);
    });
    return;
  }

  const entry: PendingRemoval = {
    seek,
    refs,
    timer: setTimeout(() => {
      dropPendingRemoval(entry);
      if (refs.length > 0) {
        deleteRefs(discordClient, refs).catch((err) => {
          console.error('Failed to remove cancelled seek announcement:', err);
        });
      }
    }, CORRELATION_WINDOW_MS),
  };
  pendingRemovals.push(entry);
}

function notifyGameAdded(discordClient: Client, game: GameListEntry): void {
  if (Date.now() < replayingUntil) return;

  // Past the replay window, so this game is starting right now.
  noteGameStarted(game.gameNo);

  const matchIndex = pendingRemovals.findIndex((p) => p.seek.player === game.white || p.seek.player === game.black);
  if (matchIndex !== -1) {
    const [match] = pendingRemovals.splice(matchIndex, 1);
    clearTimeout(match.timer);
    announceGame(discordClient, game, match.refs, match.seek).catch((err) => {
      console.error('Failed to announce game start:', err);
    });
    return;
  }

  const entry: PendingGame = {
    game,
    timer: setTimeout(() => {
      const index = pendingGames.indexOf(entry);
      if (index !== -1) pendingGames.splice(index, 1);
    }, CORRELATION_WINDOW_MS),
  };
  pendingGames.push(entry);
}

export function registerSeekToGame(discordClient: Client): void {
  const playtak = getPlaytakClient();
  playtak.on('connected', () => {
    replayingUntil = Date.now() + REPLAY_SETTLE_MS;
  });

  playtak.on('event', (event) => {
    if (event.type === 'gameListAdd') {
      notifyGameAdded(discordClient, event.game);
      return;
    }
    if (event.type === 'gameListRemove') {
      retireGameNotice(discordClient, event.game.gameNo).catch((err) => {
        console.error('Failed to retire game notice:', err);
      });
    }
  });
}
