import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { getShowBots, setShowBots } from '../playtak/showBotsStore';

export const data = new SlashCommandBuilder()
  .setName('showbots')
  .setDescription('Show or hide bot games in this channel, or check the status with no argument')
  .addStringOption((option) =>
    option
      .setName('state')
      .setDescription('on or off - leave blank to check the current status')
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
  )
  // Same default as /announce - members need Manage Channels to run this.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction: ChatInputCommandInteraction) {
  const state = interaction.options.getString('state');
  const channelId = interaction.channelId;

  if (!state) {
    const shown = getShowBots(channelId);
    await interaction.reply(`Bot games are currently **${shown ? 'shown' : 'hidden'}** in this channel.`);
    return;
  }

  const show = state === 'on';
  setShowBots(channelId, show);
  await interaction.reply(
    show
      ? 'Bot games will now be **shown** here, same as human games.'
      : 'Bot games are now **hidden** here - only human-vs-human games will get seek and game-started announcements.',
  );
}
