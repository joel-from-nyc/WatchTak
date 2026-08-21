import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { toggleAnnounce, recordConfirmationMessage } from '../playtak/announcer';

export const data = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Toggle announcements here when a human opens a new PlayTak seek');

export async function execute(interaction: ChatInputCommandInteraction) {
  // Toggling on posts one message per currently-open seek, so defer rather
  // than risk blowing the 3s interaction deadline on a busy board.
  await interaction.deferReply();
  const nowOn = await toggleAnnounce(interaction.client, interaction.channelId);
  const reply = await interaction.editReply(
    nowOn
      ? 'Seek announcements are now **on** in this channel. ' +
          "I'll keep a live list here of open seeks posted by humans (bot seeks are skipped), " +
          'removing each one as it gets taken or cancelled. This stays on across restarts.'
      : 'Seek announcements are now **off** in this channel, and I cleared the ones I posted.',
  );

  // Recorded so this message can be found and deleted later - it's stale
  // the moment the bot restarts, since "now" no longer means now.
  if (nowOn) {
    recordConfirmationMessage(interaction.channelId, reply.id);
  }
}
