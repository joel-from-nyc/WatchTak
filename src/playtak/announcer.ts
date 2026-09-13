import { Client, TextChannel } from 'discord.js';
import { PlaytakClient } from './client';
import { GameListEntry, Seek } from './protocol';
import { getSeekRegistry } from './shared';
import {
  AnnounceMode,
  loadAnnounceState,
  setChannelAnnouncing,
  clearChannelAnnouncing,
  setChannelMode,
  resolveMode,
} from './announceStore';
import { formatGameType, formatKomi, formatSeekColor } from './format';
import { notifySeekRemoved, SeekMessageRef } from './seekToGame';
import { getShowBots } from './showBotsStore';
import { getRatingRule, RatingRule } from './ratingStore';
import { getRating, isRatedBot, formatPlayerBold } from './ratings';

// PlayTak replays every open seek on (re)connect and never sends removals for
// seeks that closed while disconnected. Reconciliation waits this long for
// the replay to land.
const RECONNECT_RECONCILE_MS = 2000;

// Identifies the bot's own seek announcements in a channel's history.
const ANNOUNCEMENT_MARKER = 'has created a new game:';

// Placeholder message ids for a seek whose announcement is still being sent.
// Real ids are all digits, so these cannot collide.
const PENDING = 'pending';
const PENDING_REMOVED = 'pending-removed';

// Discord's error code for a channel the bot can no longer post in.
const MISSING_ACCESS_CODE = 50001;

// Consecutive Missing Access failures before /announce is turned off in a
// channel automatically.
const MAX_CONSECUTIVE_MISSING_ACCESS = 3;

// PlayTak guest accounts are named "Guest" plus a number.
const GUEST_NAME_PATTERN = /^Guest\d+$/;

// A channel with /announce on. `tracked` maps each shown seek to its
// announcement message id. `mode` gates game-started notices only.
interface ChannelAnnounceState {
  tracked: Map<number, string>;
  mode: AnnounceMode;
}

const announcements = new Map<string, ChannelAnnounceState>();

const missingAccessStreak = new Map<string, number>();

// Bot status per player name, from the protocol-v2 flag on every `Seek new`
// line seen. This is how the bot learns whether a seek's *acceptor* is a bot:
// the protocol never says who accepted a seek.
const knownBotByName = new Map<string, boolean>();

function isGuestName(name: string): boolean {
  return GUEST_NAME_PATTERN.test(name);
}

// True when `name` is known to be a bot from the seek flag, a previous seek,
// or the ratings list. Unknown players are assumed human.
function isConfirmedBot(name: string, seek: Seek | undefined): boolean {
  if (seek && seek.player === name && seek.isBot !== undefined) return seek.isBot;
  if (knownBotByName.get(name) === true) return true;
  return isRatedBot(name) === true;
}

function isLoggedInUser(name: string, seek: Seek | undefined): boolean {
  return !isGuestName(name) && !isConfirmedBot(name, seek);
}

// The notice rules only need player names, so /prune can re-run them against
// names parsed from an old message.
type NamedGame = Pick<GameListEntry, 'white' | 'black'>;

// Bot-vs-bot games never get a notice in any mode.
function isBotVsBot(game: NamedGame, seek: Seek | undefined): boolean {
  return isConfirmedBot(game.white, seek) && isConfirmedBot(game.black, seek);
}

// A game passes a /rating rule when at least one side is a registered human
// meeting `humanMin` whose opponent is another human (any rating) or a bot
// meeting `botMin`. Unknown ratings fail a bound rather than pass it.
function ratingRuleAllows(rule: RatingRule, game: NamedGame, seek: Seek | undefined): boolean {
  for (const [human, opponent] of [
    [game.white, game.black],
    [game.black, game.white],
  ]) {
    if (!isLoggedInUser(human, seek)) continue;
    if (rule.humanMin !== undefined) {
      const humanRating = getRating(human);
      if (humanRating === undefined || humanRating < rule.humanMin) continue;
    }
    if (isConfirmedBot(opponent, seek) && rule.botMin !== undefined) {
      const botRating = getRating(opponent);
      if (botRating === undefined || botRating < rule.botMin) continue;
    }
    return true;
  }
  return false;
}

// Whether a channel should post a game-started notice for `game`. Order of
// precedence: bot-vs-bot never; `quiet` never; a /rating rule, if set, is
// the whole decision; otherwise /showbots then the mode's own filter.
function modeAllowsGame(
  mode: AnnounceMode,
  game: NamedGame,
  seek: Seek | undefined,
  showBots: boolean,
  ratingRule: RatingRule | undefined,
): boolean {
  if (isBotVsBot(game, seek)) return false;
  if (mode === 'quiet') return false;
  if (ratingRule) return ratingRuleAllows(ratingRule, game, seek);
  if (!showBots && (isConfirmedBot(game.white, seek) || isConfirmedBot(game.black, seek))) return false;
  switch (mode) {
    case 'on':
      return true;
    case 'noguest':
      return !isGuestName(game.white) && !isGuestName(game.black);
    case 'users':
      return isLoggedInUser(game.white, seek) || isLoggedInUser(game.black, seek);
  }
}

function describeSeek(seek: Seek): string {
  const minutes = Math.floor(seek.timeSeconds / 60);
  const color = formatSeekColor(seek.color);
  const gameType = formatGameType(seek.unrated, seek.tournament);
  const komi = formatKomi(seek.komi);
  return (
    `${formatPlayerBold(seek.player)} ${ANNOUNCEMENT_MARKER} ${seek.boardSize}x${seek.boardSize}, ` +
    `${minutes}+${seek.incrementSeconds}, ${komi} komi, ${color}, ${gameType}\n` +
    // Angle brackets around the URL suppress Discord's link preview.
    'Head over to [PlayTak.com](<https://playtak.com>) to join the game!'
  );
}

// Public seeks from confirmed humans only. Bot seeks stay open near-
// permanently; private challenges cannot be accepted by anyone else.
function isAnnounceable(seek: Seek): boolean {
  return seek.opponent === '' && seek.isBot === false;
}

export function isAnnouncing(channelId: string): boolean {
  return announcements.has(channelId);
}

export function getAnnounceMode(channelId: string): AnnounceMode {
  return announcements.get(channelId)?.mode ?? 'on';
}

// Changes the mode of a channel that is already announcing. No-op otherwise.
export function setAnnounceMode(channelId: string, mode: AnnounceMode): void {
  const state = announcements.get(channelId);
  if (!state) return;
  state.mode = mode;
  setChannelMode(channelId, mode);
}

export function isGameNoticeAllowed(channelId: string, game: GameListEntry, seek: Seek | undefined): boolean {
  return modeAllowsGame(getAnnounceMode(channelId), game, seek, getShowBots(channelId), getRatingRule(channelId));
}

// Channels that would post a game-started notice for `game` right now.
export function listAnnouncingChannelIds(game: GameListEntry, seek: Seek | undefined): string[] {
  return [...announcements.entries()]
    .filter(([channelId, state]) =>
      modeAllowsGame(state.mode, game, seek, getShowBots(channelId), getRatingRule(channelId)),
    )
    .map(([channelId]) => channelId);
}

// Same decision from player names alone, for /prune's re-check of old notices.
export function wouldGameNoticeBeAllowed(channelId: string, white: string, black: string): boolean {
  return modeAllowsGame(
    getAnnounceMode(channelId),
    { white, black },
    undefined,
    getShowBots(channelId),
    getRatingRule(channelId),
  );
}

// Whether `messageId` is a seek announcement this module still tracks.
export function isTrackedSeekMessage(channelId: string, messageId: string): boolean {
  const tracked = announcements.get(channelId)?.tracked;
  if (!tracked) return false;
  for (const trackedMessageId of tracked.values()) {
    if (trackedMessageId === messageId) return true;
  }
  return false;
}

export async function fetchTextChannel(discordClient: Client, channelId: string): Promise<TextChannel | null> {
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  return channel instanceof TextChannel ? channel : null;
}

function isMissingAccessError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === MISSING_ACCESS_CODE;
}

// Records the outcome of a post or edit in an announcing channel (`err` is
// null on success). After MAX_CONSECUTIVE_MISSING_ACCESS failures in a row,
// /announce is turned off there. Any other outcome resets the streak.
export function notePostOutcome(discordClient: Client, channelId: string, err: unknown): void {
  if (err !== null && isMissingAccessError(err)) {
    const streak = (missingAccessStreak.get(channelId) ?? 0) + 1;
    if (streak < MAX_CONSECUTIVE_MISSING_ACCESS) {
      missingAccessStreak.set(channelId, streak);
      return;
    }
    missingAccessStreak.delete(channelId);
    console.error(
      `Turning off /announce in ${channelId}: ${streak} consecutive "Missing Access" errors posting there - ` +
        'the bot has likely lost permission to send messages in this channel.',
    );
    turnOffAnnounce(discordClient, channelId).catch((offErr) => {
      console.error(`Failed to auto-disable /announce in ${channelId}:`, offErr);
    });
    return;
  }
  missingAccessStreak.delete(channelId);
}

// Posts a seek announcement. The seek's slot is reserved with PENDING before
// the send, so a `Seek remove` arriving mid-send can mark it (see
// deleteTracked()) and the message is deleted as soon as it exists.
async function postSeek(channel: TextChannel, tracked: Map<number, string>, seek: Seek): Promise<void> {
  tracked.set(seek.id, PENDING);
  const message = await channel.send(describeSeek(seek)).catch((err) => {
    console.error(`Failed to post seek announcement to ${channel.id}:`, err);
    notePostOutcome(channel.client, channel.id, err);
    return null;
  });
  if (message) notePostOutcome(channel.client, channel.id, null);

  const removedWhilePending = tracked.get(seek.id) === PENDING_REMOVED;
  if (!message) {
    if (!removedWhilePending) tracked.delete(seek.id);
    return;
  }
  if (removedWhilePending) {
    tracked.delete(seek.id);
    await channel.messages.delete(message.id).catch(() => {});
    return;
  }
  tracked.set(seek.id, message.id);
}

// Stops tracking a seek and returns its message id without deleting the
// message, so seekToGame.ts can convert it into a game notice. Returns
// undefined for an untracked or still-pending seek.
function takeTracked(tracked: Map<number, string>, seekId: number): string | undefined {
  const messageId = tracked.get(seekId);
  if (!messageId || messageId === PENDING || messageId === PENDING_REMOVED) return undefined;
  tracked.delete(seekId);
  return messageId;
}

async function deleteTracked(channel: TextChannel, tracked: Map<number, string>, seekId: number): Promise<void> {
  const messageId = tracked.get(seekId);
  if (!messageId) return;
  if (messageId === PENDING) {
    tracked.set(seekId, PENDING_REMOVED);
    return;
  }
  tracked.delete(seekId);
  // Individual deletion: deleting one's own messages needs no extra permission.
  await channel.messages.delete(messageId).catch(() => {});
}

// Deletes seek announcements left by a previous run, matched by content
// since their ids are not persisted.
async function clearStaleAnnouncements(channel: TextChannel, botId: string): Promise<void> {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;
  for (const message of recent.values()) {
    if (message.author.id !== botId) continue;
    if (!message.content.includes(ANNOUNCEMENT_MARKER)) continue;
    await message.delete().catch(() => {});
  }
}

// Clears stale announcements, then posts every currently open human seek.
async function activateChannel(
  discordClient: Client,
  channel: TextChannel,
  mode: AnnounceMode,
): Promise<Map<number, string>> {
  const tracked = new Map<number, string>();
  announcements.set(channel.id, { tracked, mode });

  const botId = discordClient.user?.id;
  if (botId) await clearStaleAnnouncements(channel, botId);
  for (const seek of getSeekRegistry().list()) {
    if (isAnnounceable(seek)) await postSeek(channel, tracked, seek);
  }
  return tracked;
}

// No-op if already on. Persistence is the caller's job (see
// recordConfirmationMessage()).
export async function turnOnAnnounce(
  discordClient: Client,
  channelId: string,
  mode: AnnounceMode = 'on',
): Promise<void> {
  if (announcements.has(channelId)) return;

  const channel = await fetchTextChannel(discordClient, channelId);
  if (channel) {
    await activateChannel(discordClient, channel, mode);
  } else {
    announcements.set(channelId, { tracked: new Map(), mode });
  }
}

// Removes the channel's announcements. No-op if already off.
export async function turnOffAnnounce(discordClient: Client, channelId: string): Promise<void> {
  const existing = announcements.get(channelId);
  if (!existing) return;

  announcements.delete(channelId);
  clearChannelAnnouncing(channelId);
  const channel = await fetchTextChannel(discordClient, channelId);
  if (channel) {
    for (const seekId of [...existing.tracked.keys()]) {
      await deleteTracked(channel, existing.tracked, seekId);
    }
  }
}

// Persists the channel as announcing along with the id of its "now on"
// confirmation message, which is deleted on shutdown or the next start.
export function recordConfirmationMessage(channelId: string, messageId: string, mode: AnnounceMode = 'on'): void {
  setChannelAnnouncing(channelId, messageId, mode);
}

// Drops announcements for seeks that are no longer open after a reconnect.
async function reconcile(discordClient: Client): Promise<void> {
  const openSeekIds = new Set(
    getSeekRegistry()
      .list()
      .map((seek) => seek.id),
  );

  for (const [channelId, { tracked }] of announcements) {
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) continue;
    for (const seekId of [...tracked.keys()]) {
      if (!openSeekIds.has(seekId)) {
        await deleteTracked(channel, tracked, seekId);
      }
    }
  }
}

// Resumes every channel persisted as announcing: deletes the previous run's
// confirmation message and rebuilds the seek list. Runs once per process.
export async function resumeAnnouncing(discordClient: Client): Promise<void> {
  const state = loadAnnounceState();
  for (const [channelId, entry] of Object.entries(state)) {
    const mode = resolveMode(entry);
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) {
      // A transient fetch failure must not leave a persisted-on channel
      // absent from `announcements`.
      announcements.set(channelId, { tracked: new Map(), mode });
      continue;
    }
    await channel.messages.delete(entry.confirmationMessageId).catch(() => {});
    await activateChannel(discordClient, channel, mode);
  }
}

// Deletes each announcing channel's confirmation message before exit. The
// persisted on/off state is left alone.
export async function shutdownAnnouncer(discordClient: Client): Promise<void> {
  const state = loadAnnounceState();
  for (const [channelId, { confirmationMessageId }] of Object.entries(state)) {
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) continue;
    await channel.messages.delete(confirmationMessageId).catch(() => {});
  }
}

export function registerAnnouncer(playtak: PlaytakClient, discordClient: Client): void {
  playtak.on('event', async (event) => {
    if (event.type !== 'seekNew' && event.type !== 'seekRemove') return;

    const seek = event.seek;
    if (event.type === 'seekNew' && seek.isBot !== undefined) {
      knownBotByName.set(seek.player, seek.isBot);
    }

    // On removal, tracked messages are handed to seekToGame.ts, which
    // converts them into game notices or deletes them.
    const removedRefs: SeekMessageRef[] = [];

    for (const [channelId, { tracked }] of announcements) {
      const channel = await fetchTextChannel(discordClient, channelId);
      if (!channel) continue;

      if (event.type === 'seekRemove') {
        const messageId = takeTracked(tracked, seek.id);
        if (messageId) {
          removedRefs.push({ channelId, messageId });
        } else {
          await deleteTracked(channel, tracked, seek.id);
        }
        continue;
      }

      // Reconnects replay every open seek as `Seek new`.
      if (tracked.has(seek.id)) continue;
      if (!isAnnounceable(seek)) continue;

      await postSeek(channel, tracked, seek);
    }

    if (event.type === 'seekRemove') {
      notifySeekRemoved(discordClient, seek, removedRefs);
    }
  });

  playtak.on('connected', () => {
    setTimeout(() => {
      reconcile(discordClient).catch((err) => {
        console.error('Failed to reconcile seek announcements after reconnect:', err);
      });
    }, RECONNECT_RECONCILE_MS);
  });

  playtak.once('connected', () => {
    setTimeout(() => {
      resumeAnnouncing(discordClient).catch((err) => {
        console.error('Failed to resume /announce state after startup:', err);
      });
    }, RECONNECT_RECONCILE_MS);
  });
}
