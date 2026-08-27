import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry, Seek } from './protocol';
import { fetchTextChannel, listAnnouncingChannelIds, isGameNoticeAllowed, notePostOutcome } from './announcer';
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
  // The seek that was removed, kept in full (not just the player name) so a
  // later match can pass it to announceGame() - it's the only source of
  // bot-status the protocol offers, and only for this player's side (see
  // announcer.ts's modeAllowsGame()).
  seek: Seek;
  // Empty for a private (opponent-targeted) seek - it was never announced
  // anywhere, so there's nothing to edit; a match posts a fresh notice
  // instead (see postFreshGameNotice()).
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
// button can be swapped for a review link once that game finishes. Carries
// the player names too, so retireGameNotice() can render the "finished" text
// directly instead of reading the live message back - discord.js's
// `MessageManager#edit()` returns a patched clone but doesn't write it into
// the channel's message cache, so a later `messages.fetch()` can hand back
// the pre-edit content and silently overwrite the notice with stale text.
const noticesByGame = new Map<number, { refs: SeekMessageRef[]; white: string; black: string }>();

let replayingUntil = 0;

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

// Turns the seek's own announcement into the game-started notice rather than
// deleting it and posting a fresh message - same message slot, so an active
// channel doesn't accumulate two posts per game.
async function convertToGameNotice(
  discordClient: Client,
  game: GameListEntry,
  refs: SeekMessageRef[],
): Promise<void> {
  const content = `**${game.white}** vs **${game.black}** (#${game.gameNo}) has started!`;
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

// Used when there's no existing seek announcement to convert - a game that
// came from a private (opponent-targeted) challenge, such as a rematch,
// which announcer.ts never shows anywhere since it's not a public seek.
// Posts a fresh notice to every channel that's currently announcing and not
// in quiet mode, so it behaves the same as a converted one from here on
// (same retirement/pruning path, same button).
async function postFreshGameNotice(discordClient: Client, game: GameListEntry, seek: Seek | undefined): Promise<void> {
  const content = `**${game.white}** vs **${game.black}** (#${game.gameNo}) has started!`;
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

// A channel's mode can suppress game-started notices outright (`quiet`) or
// only for games that don't match its filter (`noguest`/`users`) - either
// way, seek announcements themselves are unaffected by it, so a converted
// seek that doesn't clear its channel's filter doesn't become a notice
// there, it's just deleted the same way a cancelled seek's announcement
// always has been.
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
    // A private seek was never posted anywhere - post fresh to whatever
    // channels are eligible right now, rather than nowhere.
    await postFreshGameNotice(discordClient, game, seek);
  }
}

// Once the game is over the watch button is a trap - it can no longer start a
// watch, since the game is gone from the registry. Swap it for a Review
// button (handled lazily, same as Watch - see index.ts), and prune the
// channel down to just this one message: Discord's own "X started a thread"
// system message, posted here when the thread was created, is deleted too,
// since the notice itself (now pointing at the thread via Review) is enough.
async function retireGameNotice(discordClient: Client, gameNo: number): Promise<void> {
  const notice = noticesByGame.get(gameNo);
  if (!notice) return;
  noticesByGame.delete(gameNo);

  const thread = getWatchedThread(gameNo);
  if (thread) {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    await starter?.delete().catch(() => {});
  }

  const content = `**${notice.white}** vs **${notice.black}** (#${gameNo}) has finished.`;
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

// A private, opponent-targeted seek that's confirmed non-bot - a rematch or
// any other direct challenge between two humans. announcer.ts never
// announces these (they're not public), but they're just as worth a
// game-started notice once accepted - the wire protocol offers no way to
// tell "rematch" apart from any other direct challenge anyway, so this
// covers both the same way.
function isPrivateHumanSeek(seek: Seek): boolean {
  return seek.opponent !== '' && seek.isBot === false;
}

// Called from announcer.ts the moment a seek disappears, handing over the
// announcement messages that were advertising it (empty for a seek that was
// never shown anywhere - either private, or public but posted to no
// currently-announcing channel). Fate is decided here: converted into a game
// notice (or, with no refs, posted fresh) if a matching game shows up within
// the window, deleted if it doesn't (the seek was simply cancelled) -
// deletion only applies to real refs, since there's nothing to delete for a
// private seek that never panned out.
export function notifySeekRemoved(discordClient: Client, seek: Seek, refs: SeekMessageRef[]): void {
  if (refs.length === 0 && !isPrivateHumanSeek(seek)) return;

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
