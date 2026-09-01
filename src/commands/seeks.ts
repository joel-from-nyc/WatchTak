import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { buildSeeksReply } from '../playtak/seeksReply';

export const data = new SlashCommandBuilder()
  .setName('seeks')
  .setDescription('List currently open public seeks on PlayTak');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({ content: buildSeeksReply(), flags: MessageFlags.Ephemeral });
}
