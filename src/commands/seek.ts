import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { buildSeeksReply } from '../playtak/seeksReply';

// Alias for /seeks - Discord doesn't support true command aliases, so this
// is a separate registration sharing the same logic.
export const data = new SlashCommandBuilder()
  .setName('seek')
  .setDescription('Alias for /seeks - list currently open public seeks on PlayTak');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply(buildSeeksReply());
}
