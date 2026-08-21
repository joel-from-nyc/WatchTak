import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { isAnnouncing, turnOnAnnounce, turnOffAnnounce, recordConfirmationMessage } from '../playtak/announcer';

const ON_MESSAGE =
  'Seek announcements are now **on** in this channel. ' +
  "I'll keep a live list here of open seeks posted by humans (bot seeks are skipped), " +
  'removing each one as it gets taken or cancelled. This stays on across restarts.';

export const data = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Turn seek announcements on/off here, or check the status with no argument')
  .addStringOption((option) =>
    option
      .setName('state')
      .setDescription('on or off - leave blank to check the current status')
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const state = interaction.options.getString('state');

  if (!state) {
    await interaction.reply(
      isAnnouncing(interaction.channelId)
        ? 'Seek announcements are **on** in this channel.'
        : 'Seek announcements are **off** in this channel.',
    );
    return;
  }

  if (state === 'on') {
    if (isAnnouncing(interaction.channelId)) {
      await interaction.reply('Seek announcements are already **on** in this channel.');
      return;
    }
    // Posts one message per currently-open seek, so defer rather than risk
    // blowing the 3s interaction deadline on a busy board.
    await interaction.deferReply();
    await turnOnAnnounce(interaction.client, interaction.channelId);
    const reply = await interaction.editReply(ON_MESSAGE);
    // Recorded so this message can be found and deleted later - it's stale
    // the moment the bot restarts, since "now" no longer means now.
    recordConfirmationMessage(interaction.channelId, reply.id);
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
