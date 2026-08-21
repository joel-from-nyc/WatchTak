import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { buildGamesListReply } from '../playtak/gamesReply';

// Short alias for /list - Discord doesn't support true command aliases, so
// this is a separate registration sharing the same logic.
export const data = new SlashCommandBuilder()
  .setName('l')
  .setDescription('Alias for /list - list PlayTak games currently in progress');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply(buildGamesListReply());
}
