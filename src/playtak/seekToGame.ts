import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';
import { fetchTextChannel } from './announcer';
import { getWatchedThread } from './watcher';

// PlayTak's wire protocol gives no id linking a seek to the game it becomes -
// a `Seek remove` fires identically whether the seek was cancelled or just
// got matched into a game, and a `GameList Add` carries no reference back to
// the seek that spawned it. The only signal available is that the same
// player name disappears from the seek list and appears in a new game at
// roughly the same moment, so that's what's correlated here, in both
// directions since event ordering between the two isn't guaranteed.
const CORRELATION_WINDOW_MS = 5000;

// On every (re)connect PlayTak replays the whole active game list as
// `GameList Add`. Those are hours-old games, not games just starting, so
// correlating during the replay would announce "has started!" for whatever
// happened to have a seek removed at the same moment. Mirrors the same
// settling window registry.ts and announcer.ts use for the same reason.
const REPLAY_SETTLE_MS = 2000;

// A seek announcement the bot posted and can still edit or delete.
export interface SeekMessageRef {
  channelId: string;
  messageId: string;
}

interface PendingRemoval {
  player: string;
  refs: SeekMessageRef[];
  timer: NodeJS.Timeout;
}

interface PendingGame {
  game: GameListEntry;
  timer: NodeJS.Timeout;
}

const pendingRemovals: PendingRemoval[] = [];
const pendingGames: PendingGame[] = [];

// Which announcement message(s) ended up advertising each live game, so the
// button can be swapped for a review link once that game finishes.
const noticesByGame = new Map<number, SeekMessageRef[]>();

let replayingUntil = 0;

function watchRow(gameNo: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`watch:${gameNo}`).setLabel('Watch game').setStyle(ButtonStyle.Primary),
  );
}

async function deleteRefs(discordClient: Client, refs: SeekMessageRef[]): Promise<void> {
  for (const ref of refs) {
    const channel = await fetchTextChannel(discordClient, ref.channelId);
    if (!channel) continue;
    await channel.messages.delete(ref.messageId).catch(() => {});
  }
}

// Turns the seek's own announcement into the game-started notice rather than
// deleting it and posting a fresh message - same message slot, so an active
// channel doesn't accumulate two posts per game.
async function convertToGameNotice(
  discordClient: Client,
  game: GameListEntry,
  refs: SeekMessageRef[],
): Promise<void> {
  const content = `**${game.white}** vs **${game.black}** has started!`;
  const landed: SeekMessageRef[] = [];

  for (const ref of refs) {
    const channel = await fetchTextChannel(discordClient, ref.channelId);
    if (!channel) continue;
    const edited = await channel.messages
      .edit(ref.messageId, { content, components: [watchRow(game.gameNo)] })
      .catch((err) => {
        console.error(`Failed to convert seek announcement in ${ref.channelId}:`, err);
        return null;
      });
    if (edited) landed.push(ref);
  }

  if (landed.length > 0) noticesByGame.set(game.gameNo, landed);
}

// Once the game is over the watch button is a trap - it can no longer start a
// watch, since the game is gone from the registry. Swap it for a link to the
// thread if one exists (a plain Link button needs no interaction handling and
// can't go stale), or drop the button entirely if nobody ever watched.
async function retireGameNotice(discordClient: Client, gameNo: number): Promise<void> {
  const refs = noticesByGame.get(gameNo);
  if (!refs) return;
  noticesByGame.delete(gameNo);

  const thread = getWatchedThread(gameNo);
  const components = thread
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('Review game').setStyle(ButtonStyle.Link).setURL(thread.url),
        ),
      ]
    : [];

  for (const ref of refs) {
    const channel = await fetchTextChannel(discordClient, ref.channelId);
    if (!channel) continue;
    const message = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!message) continue;
    const content = message.content.replace(/ has started!$/, ' has finished.');
    await channel.messages.edit(ref.messageId, { content, components }).catch(() => {});
  }
}

function dropPendingRemoval(entry: PendingRemoval): void {
  const index = pendingRemovals.indexOf(entry);
  if (index !== -1) pendingRemovals.splice(index, 1);
}

// Called from announcer.ts the moment a seek disappears, handing over the
// announcement messages that were advertising it. Their fate is decided here:
// edited into a game notice if a matching game shows up within the window,
// deleted if it doesn't (the seek was simply cancelled). An empty list means
// the seek wasn't being shown anywhere, so there's nothing to act on.
export function notifySeekRemoved(discordClient: Client, player: string, refs: SeekMessageRef[]): void {
  if (refs.length === 0) return;

  const matchIndex = pendingGames.findIndex((p) => p.game.white === player || p.game.black === player);
  if (matchIndex !== -1) {
    const [match] = pendingGames.splice(matchIndex, 1);
    clearTimeout(match.timer);
    convertToGameNotice(discordClient, match.game, refs).catch((err) => {
      console.error('Failed to convert seek announcement:', err);
    });
    return;
  }

  const entry: PendingRemoval = {
    player,
    refs,
    timer: setTimeout(() => {
      dropPendingRemoval(entry);
      deleteRefs(discordClient, refs).catch((err) => {
        console.error('Failed to remove cancelled seek announcement:', err);
      });
    }, CORRELATION_WINDOW_MS),
  };
  pendingRemovals.push(entry);
}

function notifyGameAdded(discordClient: Client, game: GameListEntry): void {
  if (Date.now() < replayingUntil) return;

  const matchIndex = pendingRemovals.findIndex((p) => p.player === game.white || p.player === game.black);
  if (matchIndex !== -1) {
    const [match] = pendingRemovals.splice(matchIndex, 1);
    clearTimeout(match.timer);
    convertToGameNotice(discordClient, game, match.refs).catch((err) => {
      console.error('Failed to convert seek announcement:', err);
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

export function registerSeekToGame(playtak: PlaytakClient, discordClient: Client): void {
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
