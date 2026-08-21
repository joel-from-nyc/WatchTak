import { Client, TextChannel } from 'discord.js';
import { PlaytakClient } from './client';
import { Seek } from './protocol';
import { getSeekRegistry } from './shared';
import { loadAnnounceState, setChannelAnnouncing, clearChannelAnnouncing } from './announceStore';

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

// Channels currently opted in via /announce, each mapping the seeks it's
// showing to the message announcing them. This is what makes the channel a
// live view rather than a feed: the message is deleted when its seek goes
// away, so what's on screen is what's actually joinable.
const announcements = new Map<string, Map<number, string>>();

function describeSeek(seek: Seek): string {
  const minutes = Math.floor(seek.timeSeconds / 60);
  const color = seek.color === 'A' ? 'either color' : seek.color === 'W' ? 'white' : 'black';
  const rated = seek.unrated ? 'unrated' : 'rated';
  return (
    `**${seek.player}** ${ANNOUNCEMENT_MARKER} ${seek.boardSize}x${seek.boardSize}, ` +
    `${minutes}+${seek.incrementSeconds}, ${color}, ${rated}\n` +
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

async function fetchTextChannel(discordClient: Client, channelId: string): Promise<TextChannel | null> {
  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  return channel instanceof TextChannel ? channel : null;
}

async function postSeek(channel: TextChannel, tracked: Map<number, string>, seek: Seek): Promise<void> {
  const message = await channel.send(describeSeek(seek)).catch((err) => {
    console.error(`Failed to post seek announcement to ${channel.id}:`, err);
    return null;
  });
  if (message) tracked.set(seek.id, message.id);
}

async function deleteTracked(channel: TextChannel, tracked: Map<number, string>, seekId: number): Promise<void> {
  const messageId = tracked.get(seekId);
  if (!messageId) return;
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
async function activateChannel(discordClient: Client, channel: TextChannel): Promise<Map<number, string>> {
  const tracked = new Map<number, string>();
  announcements.set(channel.id, tracked);

  const botId = discordClient.user?.id;
  if (botId) await clearStaleAnnouncements(channel, botId);
  for (const seek of getSeekRegistry().list()) {
    if (isAnnounceable(seek)) await postSeek(channel, tracked, seek);
  }
  return tracked;
}

// Shows every human seek that's open right now, so the channel is
// immediately an accurate list rather than starting empty and filling in
// only as new seeks appear. No-op if already on. The on/off state itself is
// persisted by the caller (see recordConfirmationMessage()) - this only
// handles the channel's message contents.
export async function turnOnAnnounce(discordClient: Client, channelId: string): Promise<void> {
  if (announcements.has(channelId)) return;

  const channel = await fetchTextChannel(discordClient, channelId);
  if (channel) {
    await activateChannel(discordClient, channel);
  } else {
    announcements.set(channelId, new Map());
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
    for (const seekId of [...existing.keys()]) {
      await deleteTracked(channel, existing, seekId);
    }
  }
}

// Called by /announce right after posting its "now on" confirmation, so
// that message can be found and deleted later - either on a graceful
// shutdown, or as the first thing done when resuming this channel after a
// restart, since by then it's no longer an accurate "just now" statement.
export function recordConfirmationMessage(channelId: string, messageId: string): void {
  setChannelAnnouncing(channelId, messageId);
}

// Drops announcements for seeks that are no longer open. Needed because
// removals that happen while the socket is down are never replayed - only
// the surviving seeks are - so without this, a disconnect would strand
// messages advertising games nobody can join.
async function reconcile(discordClient: Client): Promise<void> {
  const openSeekIds = new Set(getSeekRegistry().list().map((seek) => seek.id));

  for (const [channelId, tracked] of announcements) {
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
  for (const [channelId, { confirmationMessageId }] of Object.entries(state)) {
    const channel = await fetchTextChannel(discordClient, channelId);
    if (!channel) continue;
    await channel.messages.delete(confirmationMessageId).catch(() => {});
    await activateChannel(discordClient, channel);
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

    for (const [channelId, tracked] of announcements) {
      const channel = await fetchTextChannel(discordClient, channelId);
      if (!channel) continue;

      if (event.type === 'seekRemove') {
        await deleteTracked(channel, tracked, seek.id);
        continue;
      }

      // Already showing this one - PlayTak replays every open seek as
      // `Seek new` on each reconnect, so without this a brief blip would
      // duplicate every announcement on screen.
      if (tracked.has(seek.id)) continue;
      if (!isAnnounceable(seek)) continue;

      await postSeek(channel, tracked, seek);
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
