import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { buildSeeksReply } from '../playtak/seeksReply';

// Short alias for /seeks - Discord doesn't support true command aliases, so
// this is a separate registration sharing the same logic.
export const data = new SlashCommandBuilder()
  .setName('s')
  .setDescription('Alias for /seeks - list currently open public seeks on PlayTak');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply(buildSeeksReply());
}
