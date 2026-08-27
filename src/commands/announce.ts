import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import {
  isAnnouncing,
  getAnnounceMode,
  turnOnAnnounce,
  turnOffAnnounce,
  setAnnounceMode,
  recordConfirmationMessage,
} from '../playtak/announcer';
import { AnnounceMode } from '../playtak/announceStore';

const MODE_MESSAGES: Record<AnnounceMode, string> = {
  on:
    'Seek announcements are now **on** in this channel. ' +
    "I'll keep a live list here of open seeks posted by humans (bot seeks are skipped), " +
    'removing each one as it gets taken or cancelled. I\'ll also post a notice with a Watch button whenever one of ' +
    'those seeks (or a private challenge, like a rematch) turns into a live game. This stays on across restarts.',
  quiet:
    'Seek announcements are now **on (quiet)** in this channel. ' +
    "Same live seek list as usual, but I won't post game-started notices. This stays on across restarts.",
  noguest:
    'Seek announcements are now **on (no guest games)** in this channel. ' +
    "Same live seek list as usual, but I'll skip game-started notices for any game with a guest account on " +
    'either side. This stays on across restarts.',
  users:
    'Seek announcements are now **on (logged-in users only)** in this channel. ' +
    "Same live seek list as usual, but I'll only post game-started notices for games with at least one " +
    'logged-in (non-guest, non-bot) player. This stays on across restarts.',
};

const MODE_STATUS: Record<AnnounceMode, string> = {
  on: 'Seek announcements are **on** in this channel.',
  quiet: 'Seek announcements are **on (quiet)** in this channel.',
  noguest: 'Seek announcements are **on (no guest games)** in this channel.',
  users: 'Seek announcements are **on (logged-in users only)** in this channel.',
};

const MODE_ALREADY_ON: Record<AnnounceMode, string> = {
  on: 'Seek announcements are already **on** in this channel.',
  quiet: 'Seek announcements are already **on (quiet)** in this channel.',
  noguest: 'Seek announcements are already **on (no guest games)** in this channel.',
  users: 'Seek announcements are already **on (logged-in users only)** in this channel.',
};

const MODE_SWITCHED_TO: Record<AnnounceMode, string> = {
  on: "Switched off filtering - I'll post game-started notices for every game again.",
  quiet: "Switched to **quiet** mode - I'll keep the seek list going but stop posting game-started notices.",
  noguest:
    "Switched to **noguest** mode - I'll keep posting game-started notices, but skip any game with a guest " +
    'account on either side.',
  users:
    "Switched to **users** mode - I'll only post game-started notices for games with at least one logged-in " +
    '(non-guest, non-bot) player.',
};

export const data = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Turn seek announcements on/off/quiet/noguest/users here, or check the status with no argument')
  .addStringOption((option) =>
    option
      .setName('state')
      .setDescription('on, off, quiet, noguest, or users - leave blank to check the current status')
      .addChoices(
        { name: 'on', value: 'on' },
        { name: 'off', value: 'off' },
        { name: 'quiet', value: 'quiet' },
        { name: 'noguest', value: 'noguest' },
        { name: 'users', value: 'users' },
      ),
  )
  // Baseline default - members need Manage Channels to run this. A server's
  // admins can further restrict it to specific roles (or loosen it) anytime
  // via Server Settings -> Integrations -> this bot, with no redeploy needed.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

function statusText(channelId: string): string {
  if (!isAnnouncing(channelId)) return 'Seek announcements are **off** in this channel.';
  return MODE_STATUS[getAnnounceMode(channelId)];
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const state = interaction.options.getString('state');

  if (!state) {
    await interaction.reply(statusText(interaction.channelId));
    return;
  }

  if (state !== 'off') {
    const mode = state as AnnounceMode;

    if (isAnnouncing(interaction.channelId)) {
      if (getAnnounceMode(interaction.channelId) === mode) {
        await interaction.reply(MODE_ALREADY_ON[mode]);
        return;
      }
      // Switching mode on an already-active channel - just flip the flag,
      // no need to touch the seek list itself.
      setAnnounceMode(interaction.channelId, mode);
      await interaction.reply(MODE_SWITCHED_TO[mode]);
      return;
    }

    // Posts one message per currently-open seek, so defer rather than risk
    // blowing the 3s interaction deadline on a busy board.
    await interaction.deferReply();
    await turnOnAnnounce(interaction.client, interaction.channelId, mode);
    const reply = await interaction.editReply(MODE_MESSAGES[mode]);
    // Recorded so this message can be found and deleted later - it's stale
    // the moment the bot restarts, since "now" no longer means now.
    recordConfirmationMessage(interaction.channelId, reply.id, mode);
    return;
  }

  // state === 'off'
  if (!isAnnouncing(interaction.channelId)) {
    await interaction.reply('Seek announcements are already **off** in this channel.');
    return;
  }
  await interaction.deferReply();
  await turnOffAnnounce(interaction.client, interaction.channelId);
  await interaction.editReply('Seek announcements are now **off** in this channel, and I cleared the ones I posted.');
}
