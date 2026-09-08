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

// How long to let PlayTak's post-(re)connect burst of `Seek new` lines land
// before reconciling or resuming. On every (re)connect the server replays
// every currently-open seek, and any removals that happened while we were
// disconnected are simply never sent - so the replay is the only way to
// learn what's actually still open.
const RECONNECT_RECONCILE_MS = 2000;

// Distinctive enough to identify our own announcements when reconciling a
// channel we have no memory of (i.e. after a restart), without touching
// other messages the bot posts there.
const ANNOUNCEMENT_MARKER = 'has created a new game:';

// Sentinels for a tracked seek whose announcement message is still being
// sent - see postSeek()/deleteTracked() for why this matters. Discord
// snowflake ids are all-digit strings, so these can't collide with a real
// message id.
const PENDING = 'pending';
const PENDING_REMOVED = 'pending-removed';

// Discord's error code for a channel the bot can no longer see/post in -
// e.g. its permission was revoked, or it was removed from the channel.
const MISSING_ACCESS_CODE = 50001;

// How many posting attempts to a channel can fail in a row with Missing
// Access before /announce is auto-disabled there - see notePostOutcome().
const MAX_CONSECUTIVE_MISSING_ACCESS = 3;

// PlayTak guest accounts are always named "Guest" plus a numeric id (e.g.
// "Guest672") - confirmed against live traffic. Anchored and case-sensitive
// so a registered account named e.g. "guestbook" doesn't false-positive.
const GUEST_NAME_PATTERN = /^Guest\d+$/;

// A channel currently opted in via /announce: `tracked` maps the seeks it's
// showing to the message announcing them - this is what makes the channel a
// live view rather than a feed, since the message is deleted when its seek
// goes away, so what's on screen is what's actually joinable. `mode` gates
// only the seek-to-game "started!" notices (see seekToGame.ts) - seek
// announcements themselves are unaffected by it.
interface ChannelAnnounceState {
  tracked: Map<number, string>;
  mode: AnnounceMode;
}

const announcements = new Map<string, ChannelAnnounceState>();

// Consecutive Missing Access failures per channel - see notePostOutcome().
const missingAccessStreak = new Map<string, number>();

// Every player's bot status, as last reported by the protocol-v2 flag on a
// `Seek new` line for them - built up over the process's lifetime from
// every seek anyone posts, not just the announceable ones. This is the only
// way to learn whether the player on the *other* side of a game (the one
// who accepted a seek rather than posted it) is a bot: PlayTak's wire
// protocol never says who accepted a seek, only that it disappeared around
// the same time a game appeared (see seekToGame.ts's correlation), so a bot
// that only ever accepts seeks and never posts its own would otherwise be
// indistinguishable from a human. Bot status doesn't change, so a stale
// entry from an earlier seek is still correct; no eviction needed for a map
// this small (one entry per player name ever seen).
const knownBotByName = new Map<string, boolean>();

function isGuestName(name: string): boolean {
  return GUEST_NAME_PATTERN.test(name);
}

// True when `name` is known to be a bot - either it's the player who
// created `seek` and the server flagged them as one, or they've posted some
// other seek during this process's lifetime that did (see
// `knownBotByName`). A player never observed to be flagged either way is
// assumed not to be a bot, so `users` mode errs toward showing a game
// rather than hiding one on a guess.
function isConfirmedBot(name: string, seek: Seek | undefined): boolean {
  if (seek && seek.player === name && seek.isBot !== undefined) return seek.isBot;
  if (knownBotByName.get(name) === true) return true;
  // Closes a gap knownBotByName can't: a bot that only ever accepts seeks
  // (never posts its own) never shows up on a `Seek new` line as itself, so
  // the wire protocol alone can't identify it. PlayTak's own ratings list
  // flags it regardless (see ratings.ts).
  return isRatedBot(name) === true;
}

function isLoggedInUser(name: string, seek: Seek | undefined): boolean {
  return !isGuestName(name) && !isConfirmedBot(name, seek);
}

// Everything below this point that inspects "a game" only ever reads these
// two fields, never board size/time control/etc - so it's typed against just
// this shape rather than the full GameListEntry. That's what lets
// wouldGameNoticeBeAllowed() (see below) re-run the same logic against a pair
// of names recovered from old message text, with no real GameListEntry to
// hand it.
type NamedGame = Pick<GameListEntry, 'white' | 'black'>;

// A bot-vs-bot game is never worth a notice in any mode, including `on` -
// nobody watching /announce can join or usefully spectate two bots playing
// each other, so this is a hard exclusion rather than another mode option.
function isBotVsBot(game: NamedGame, seek: Seek | undefined): boolean {
  return isConfirmedBot(game.white, seek) && isConfirmedBot(game.black, seek);
}

// Whether `game` passes a channel's /rating rule - the authoritative filter
// for game notices wherever one is set (see modeAllowsGame()). A game passes
// when at least one side is a registered human meeting `rule.humanMin` whose
// opponent is either another human (any rating, guests included) or a bot
// meeting `rule.botMin`; everything else - including a game with no
// qualifying human at all - is hidden. Either bound omitted means no minimum
// on that side. Checks both ways round, since `game.white`/`game.black`
// don't say which one is meant to be the "human" side. A bound can only be
// met by a *known* rating, so unknown ratings (unrated players, and the
// window right after a restart before ratings.ts's first fetch lands) fail
// it rather than pass - the gate errs toward hiding, since its whole point
// is cutting noise.
function ratingRuleAllows(rule: RatingRule, game: NamedGame, seek: Seek | undefined): boolean {
  for (const [human, opponent] of [
    [game.white, game.black],
    [game.black, game.white],
  ]) {
    // The qualifying side must be a registered human - isLoggedInUser()
    // already excludes bots as well as guests.
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

// Whether a channel in `mode` should get a game-started notice for `game`.
// `seek` is the seek that was matched to this game, when there was one (see
// seekToGame.ts) - it's the only source of bot-status the protocol offers,
// and only for whichever side created the seek. `showBots` is this channel's
// /showbots setting - when off, any game with a confirmed bot on either side
// is excluded outright, on top of whatever `mode` would otherwise allow.
//
// A /rating rule, where one is set, is the authoritative filter instead: it
// both forces qualifying games through (a strong human playing a strong bot
// shows even with showbots off) and hides everything that misses it, which
// makes `showBots` and the `noguest`/`users` modes moot in that channel -
// the rule's own bounds are stricter than any of them (see
// ratingRuleAllows()).
//
// `quiet` is checked before the rating rule deliberately: that mode means
// "no game-started notices at all here", so it stays truly quiet rather than
// being punched through by the rule.
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
    // Angle brackets inside the masked link suppress Discord's link-preview
    // embed, leaving just the clickable text.
    'Head over to [PlayTak.com](<https://playtak.com>) to join the game!'
  );
}

// Bots keep seeks open more or less permanently, so announcing them would
// bury the human ones this feature exists for. `isBot` is undefined when
// the server didn't send a protocol-v2 seek line; treat that as "don't
// know" and stay quiet rather than risk spamming bot seeks. Private
// challenges are excluded too - nobody else can accept them.
function isAnnounceable(seek: Seek): boolean {
  return seek.opponent === '' && seek.isBot === false;
}

export function isAnnouncing(channelId: string): boolean {
  return announcements.has(channelId);
}

export function getAnnounceMode(channelId: string): AnnounceMode {
  return announcements.get(channelId)?.mode ?? 'on';
}

// Flips the mode on a channel that's already announcing, without resetting
// its tracked seek list - see announce.ts's mode-switching. No-op if the
// channel isn't currently announcing.
export function setAnnounceMode(channelId: string, mode: AnnounceMode): void {
  const state = announcements.get(channelId);
  if (!state) return;
  state.mode = mode;
  setChannelMode(channelId, mode);
}

// Whether a channel should get a game-started notice for `game` right now -
// used by seekToGame.ts when it has an existing seek announcement it could
// convert into one.
export function isGameNoticeAllowed(channelId: string, game: GameListEntry, seek: Seek | undefined): boolean {
  return modeAllowsGame(getAnnounceMode(channelId), game, seek, getShowBots(channelId), getRatingRule(channelId));
}

// Channels eligible for a fresh "started!" notice for `game` right now -
// used by seekToGame.ts's postFreshGameNotice() when there's no existing
// seek announcement to convert (a private/rematch-derived game).
export function listAnnouncingChannelIds(game: GameListEntry, seek: Seek | undefined): string[] {
  return [...announcements.entries()]
    .filter(([channelId, state]) => modeAllowsGame(state.mode, game, seek, getShowBots(channelId), getRatingRule(channelId)))
    .map(([channelId]) => channelId);
}

// Re-derives "would this channel's current settings allow a game-started
// notice for these two players" from names alone - no seek/game object
// needed, since `seek: undefined` just means bot-detection falls back to
// `knownBotByName`/`isRatedBot()` (identity-based, not tied to a specific
// seek). Used by /prune to decide whether an old notice, parsed back out of
// its own message text, still matches the rules.
export function wouldGameNoticeBeAllowed(channelId: string, white: string, black: string): boolean {
  return modeAllowsGame(getAnnounceMode(channelId), { white, black }, undefined, getShowBots(channelId), getRatingRule(channelId));
}

// Whether `messageId` is still a live-tracked seek announcement in this
// channel - i.e. it could still be converted into (or already is on its way
// to becoming) a game-started notice, so /prune must leave it alone rather
// than risk deleting something announcer.ts still has a reference to.
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

// Called after every attempt to post or edit a message in an announcing
// channel (`err` is the caught error, or null on success), so a channel
// that's permanently lost the ability to post there - kicked out, or its
// permissions revoked - gets /announce turned off automatically instead of
// failing, and re-logging the same error, on every single seek and game
// event forever. Only counts consecutive Missing Access failures: anything
// else (a rate limit, a network blip, or a success) resets the streak,
// since those aren't evidence of a permanent problem.
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

// Reserves the seek's slot with PENDING before the `send` even starts, so a
// `Seek remove` arriving mid-send (the handler isn't serialized - see
// registerAnnouncer()) has something to mark rather than silently no-op'ing
// against a map that doesn't have the id yet. Without this, that race could
// leave a permanent "join this game!" post for a seek that's already gone -
// exactly what /announce exists to prevent.
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

// Hands a tracked seek's message off to the caller and stops tracking it,
// without deleting anything - used on `Seek remove`, where the message isn't
// necessarily rubbish: if the seek was taken rather than cancelled it gets
// edited in place into a "game started" notice instead (see seekToGame.ts).
// Returns undefined when there's nothing to hand over, including the
// still-being-sent case, which stays on deleteTracked's PENDING_REMOVED path
// since there's no message id to give out yet.
function takeTracked(tracked: Map<number, string>, seekId: number): string | undefined {
  const messageId = tracked.get(seekId);
  if (!messageId || messageId === PENDING || messageId === PENDING_REMOVED) return undefined;
  tracked.delete(seekId);
  return messageId;
}

async function deleteTracked(channel: TextChannel, tracked: Map<number, string>, seekId: number): Promise<void> {
  const messageId = tracked.get(seekId);
  if (!messageId) return;
  // The announcement hasn't been sent yet - mark it so postSeek() deletes
  // the message itself the moment it knows what that message is.
  if (messageId === PENDING) {
    tracked.set(seekId, PENDING_REMOVED);
    return;
  }
  tracked.delete(seekId);
  // Deleted individually rather than via bulkDelete: bulk deletion needs
  // the "Manage Messages" permission, but a bot can always delete its own
  // messages without it.
  await channel.messages.delete(messageId).catch(() => {});
}

// Clears announcements left in a channel by a previous run. The toggle
// state survives a restart (see announceStore.ts), but the individual seek
// messages' tracking doesn't - and seeks may have opened/closed while we
// were down anyway - so this sweeps for old ones by content rather than by
// remembered id. Matching on the marker keeps this from touching the bot's
// other messages here.
async function clearStaleAnnouncements(channel: TextChannel, botId: string): Promise<void> {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;
  for (const message of recent.values()) {
    if (message.author.id !== botId) continue;
    if (!message.content.includes(ANNOUNCEMENT_MARKER)) continue;
    await message.delete().catch(() => {});
  }
}

// Wipes any stale announcements in the channel, then posts every human seek
// that's currently open. Shared by toggling on and by resuming after a
// restart - both start a channel from the same "accurate right now" state.
async function activateChannel(discordClient: Client, channel: TextChannel, mode: AnnounceMode): Promise<Map<number, string>> {
  const tracked = new Map<number, string>();
  announcements.set(channel.id, { tracked, mode });

  const botId = discordClient.user?.id;
  if (botId) await clearStaleAnnouncements(channel, botId);
  for (const seek of getSeekRegistry().list()) {
    if (isAnnounceable(seek)) await postSeek(channel, tracked, seek);
  }
  return tracked;
}

// Shows every human seek that's open right now, so the channel is
// immediately an accurate list rather than starting empty and filling in
// only as new seeks appear. No-op if already on (in any mode - use
// setAnnounceMode() to switch modes on an already-active channel without a
// full reset). The on/off state itself is persisted by the caller (see
// recordConfirmationMessage()) - this only handles the channel's message
// contents.
export async function turnOnAnnounce(discordClient: Client, channelId: string, mode: AnnounceMode = 'on'): Promise<void> {
  if (announcements.has(channelId)) return;

  const channel = await fetchTextChannel(discordClient, channelId);
  if (channel) {
    await activateChannel(discordClient, channel, mode);
  } else {
    announcements.set(channelId, { tracked: new Map(), mode });
  }
}

// Removes the announcements, since a stale list of "joinable" games is
// worse than none. No-op if already off.
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

// Called by /announce right after posting its "now on" confirmation, so
// that message can be found and deleted later - either on a graceful
// shutdown, or as the first thing done when resuming this channel after a
// restart, since by then it's no longer an accurate "just now" statement.
export function recordConfirmationMessage(channelId: string, messageId: string, mode: AnnounceMode = 'on'): void {
  setChannelAnnouncing(channelId, messageId, mode);
}

// Drops announcements for seeks that are no longer open. Needed because
// removals that happen while the socket is down are never replayed - only
// the surviving seeks are - so without this, a disconnect would strand
// messages advertising games nobody can join.
async function reconcile(discordClient: Client): Promise<void> {
  const openSeekIds = new Set(getSeekRegistry().list().map((seek) => seek.id));

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

// Resumes any channels that were toggled on before this process started -
// the toggle itself is meant to survive a restart (see announceStore.ts),
// so this isn't turning anything on that wasn't already on. It just deletes
// the now-stale "now on" confirmation from before the restart and refreshes
// the seek list, the same way toggling on does. Called once on the bot's
// first connect, not on every reconnect - see registerAnnouncer().
export async function resumeAnnouncing(discordClient: Client): Promise<void> {
  const state = loadAnnounceState();
  for (const [channelId, entry] of Object.entries(state)) {
    const mode = resolveMode(entry);
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) {
      // Channel fetch can fail transiently (a rate limit, a momentary cache
      // miss) even though the channel is fine. Falling through here would
      // leave this channel out of `announcements` while announce-state.json
      // still says it's on - isAnnouncing() would report off and nothing
      // would ever post again until someone ran /announce by hand. Mirrors
      // turnOnAnnounce()'s same fallback for the same reason.
      announcements.set(channelId, { tracked: new Map(), mode });
      continue;
    }
    await channel.messages.delete(entry.confirmationMessageId).catch(() => {});
    await activateChannel(discordClient, channel, mode);
  }
}

// Deletes the "now on" confirmation message in every currently-announcing
// channel. Meant for a graceful shutdown - the toggle state itself is left
// alone, so resumeAnnouncing() picks the channel back up on the next start.
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

    // The announcement messages that were advertising this seek. On removal
    // they're handed to seekToGame.ts rather than deleted here, since it can
    // still turn them into "game started" notices - it deletes them itself if
    // the seek turns out to have simply been cancelled.
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

      // Already showing this one - PlayTak replays every open seek as
      // `Seek new` on each reconnect, so without this a brief blip would
      // duplicate every announcement on screen.
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
