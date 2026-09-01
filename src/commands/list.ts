import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { buildGamesListReply } from '../playtak/gamesReply';

export const data = new SlashCommandBuilder()
  .setName('list')
  .setDescription('List PlayTak games currently in progress');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({ content: buildGamesListReply(), flags: MessageFlags.Ephemeral });
}
