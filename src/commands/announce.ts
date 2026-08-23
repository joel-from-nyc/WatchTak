import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import {
  isAnnouncing,
  isAnnounceQuiet,
  turnOnAnnounce,
  turnOffAnnounce,
  setAnnounceQuiet,
  recordConfirmationMessage,
} from '../playtak/announcer';

const ON_MESSAGE =
  'Seek announcements are now **on** in this channel. ' +
  "I'll keep a live list here of open seeks posted by humans (bot seeks are skipped), " +
  'removing each one as it gets taken or cancelled. I\'ll also post a notice with a Watch button whenever one of ' +
  'those seeks (or a private challenge, like a rematch) turns into a live game. This stays on across restarts.';

const QUIET_MESSAGE =
  'Seek announcements are now **on (quiet)** in this channel. ' +
  "Same live seek list as usual, but I won't post game-started notices. This stays on across restarts.";

export const data = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Turn seek announcements on/off/quiet here, or check the status with no argument')
  .addStringOption((option) =>
    option
      .setName('state')
      .setDescription('on, off, or quiet - leave blank to check the current status')
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }, { name: 'quiet', value: 'quiet' }),
  )
  // Baseline default - members need Manage Channels to run this. A server's
  // admins can further restrict it to specific roles (or loosen it) anytime
  // via Server Settings -> Integrations -> this bot, with no redeploy needed.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

function statusText(channelId: string): string {
  if (!isAnnouncing(channelId)) return 'Seek announcements are **off** in this channel.';
  return isAnnounceQuiet(channelId)
    ? 'Seek announcements are **on (quiet)** in this channel.'
    : 'Seek announcements are **on** in this channel.';
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const state = interaction.options.getString('state');

  if (!state) {
    await interaction.reply(statusText(interaction.channelId));
    return;
  }

  if (state === 'on' || state === 'quiet') {
    const quiet = state === 'quiet';

    if (isAnnouncing(interaction.channelId)) {
      if (isAnnounceQuiet(interaction.channelId) === quiet) {
        await interaction.reply(
          quiet
            ? 'Seek announcements are already **on (quiet)** in this channel.'
            : 'Seek announcements are already **on** in this channel.',
        );
        return;
      }
      // Switching mode on an already-active channel - just flip the flag,
      // no need to touch the seek list itself.
      setAnnounceQuiet(interaction.channelId, quiet);
      await interaction.reply(
        quiet
          ? "Switched to **quiet** mode - I'll keep the seek list going but stop posting game-started notices."
          : "Switched off quiet mode - I'll post game-started notices again.",
      );
      return;
    }

    // Posts one message per currently-open seek, so defer rather than risk
    // blowing the 3s interaction deadline on a busy board.
    await interaction.deferReply();
    await turnOnAnnounce(interaction.client, interaction.channelId, quiet);
    const reply = await interaction.editReply(quiet ? QUIET_MESSAGE : ON_MESSAGE);
    // Recorded so this message can be found and deleted later - it's stale
    // the moment the bot restarts, since "now" no longer means now.
    recordConfirmationMessage(interaction.channelId, reply.id, quiet);
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
