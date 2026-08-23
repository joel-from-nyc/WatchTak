import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry } from './protocol';
import { fetchTextChannel } from './announcer';

// PlayTak's wire protocol gives no id linking a seek to the game it becomes -
// a `Seek remove` fires identically whether the seek was cancelled or just
// got matched into a game, and a `GameList Add` carries no reference back to
// the seek that spawned it. The only signal available is that the same
// player name disappears from the seek list and appears in a new game at
// roughly the same moment, so that's what's correlated here, in both
// directions since event ordering between the two isn't guaranteed.
const CORRELATION_WINDOW_MS = 5000;

interface PendingRemoval {
  player: string;
  channelIds: string[];
  expiresAt: number;
}

interface PendingGame {
  game: GameListEntry;
  expiresAt: number;
}

const pendingRemovals: PendingRemoval[] = [];
const pendingGames: PendingGame[] = [];

function prune(): void {
  const now = Date.now();
  for (let i = pendingRemovals.length - 1; i >= 0; i--) {
    if (pendingRemovals[i].expiresAt < now) pendingRemovals.splice(i, 1);
  }
  for (let i = pendingGames.length - 1; i >= 0; i--) {
    if (pendingGames[i].expiresAt < now) pendingGames.splice(i, 1);
  }
}

async function postGameStartedNotice(discordClient: Client, game: GameListEntry, channelIds: string[]): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`watch:${game.gameNo}`).setLabel('Watch game').setStyle(ButtonStyle.Primary),
  );
  const content = `**${game.white}** vs **${game.black}** has started!`;

  for (const channelId of channelIds) {
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) continue;
    await channel.send({ content, components: [row] }).catch((err) => {
      console.error(`Failed to post game-started notice to ${channelId}:`, err);
    });
  }
}

// Called from announcer.ts right when a seek disappears, with the channels
// that were actually showing it (i.e. where it was public/human and
// /announce is on) - an empty list means nobody could have clicked "join"
// on it anyway, so there's nothing to notify.
export function notifySeekRemoved(discordClient: Client, player: string, channelIds: string[]): void {
  if (channelIds.length === 0) return;
  prune();

  const matchIndex = pendingGames.findIndex((p) => p.game.white === player || p.game.black === player);
  if (matchIndex !== -1) {
    const [match] = pendingGames.splice(matchIndex, 1);
    postGameStartedNotice(discordClient, match.game, channelIds).catch((err) => {
      console.error('Failed to post game-started notice:', err);
    });
    return;
  }

  pendingRemovals.push({ player, channelIds, expiresAt: Date.now() + CORRELATION_WINDOW_MS });
}

function notifyGameAdded(discordClient: Client, game: GameListEntry): void {
  prune();

  const matchIndex = pendingRemovals.findIndex((p) => p.player === game.white || p.player === game.black);
  if (matchIndex !== -1) {
    const [match] = pendingRemovals.splice(matchIndex, 1);
    postGameStartedNotice(discordClient, game, match.channelIds).catch((err) => {
      console.error('Failed to post game-started notice:', err);
    });
    return;
  }

  pendingGames.push({ game, expiresAt: Date.now() + CORRELATION_WINDOW_MS });
}

export function registerSeekToGame(playtak: PlaytakClient, discordClient: Client): void {
  playtak.on('event', (event) => {
    if (event.type !== 'gameListAdd') return;
    notifyGameAdded(discordClient, event.game);
  });
}
