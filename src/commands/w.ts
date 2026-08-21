import { SlashCommandBuilder } from 'discord.js';
import { execute } from './watch';

// Short alias for /watch - Discord doesn't support true command aliases, so
// this is a separate registration sharing the same logic.
export const data = new SlashCommandBuilder()
  .setName('w')
  .setDescription('Alias for /watch - watch a live PlayTak game in a thread, or list active games if blank')
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Game ID, or a player name (partial names ok, e.g. "grup" matches "gruppler")')
      .setRequired(false),
  );

export { execute };
