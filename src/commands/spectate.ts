import { SlashCommandBuilder } from 'discord.js';
import { execute } from './watch';

// Synonym for /watch - Discord doesn't support true command aliases, so
// this is a separate registration sharing the same logic.
export const data = new SlashCommandBuilder()
  .setName('spectate')
  .setDescription('Same as /watch - follow a live PlayTak game in a thread')
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Game ID, or a player name (partial names ok, e.g. "grup" matches "gruppler")')
      .setRequired(false),
  );

export { execute };
