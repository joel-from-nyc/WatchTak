import { SlashCommandBuilder } from 'discord.js';
import { execute, autocomplete } from './watch';

// Alias for /watch. Discord has no alias support, so this is a separate
// registration sharing the same handlers. Autocomplete is declared per
// registration, so the option is repeated here.
export const data = new SlashCommandBuilder()
  .setName('spectate')
  .setDescription('Same as /watch - follow a live PlayTak game in a thread')
  .addStringOption((option) =>
    option
      .setName('game')
      .setDescription('Game ID, or a player name (partial names ok, e.g. "grup" matches "gruppler")')
      .setRequired(false)
      .setAutocomplete(true),
  );

export { execute, autocomplete };
