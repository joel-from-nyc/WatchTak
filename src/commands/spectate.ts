import { SlashCommandBuilder } from 'discord.js';
import { execute, autocomplete } from './watch';

// Synonym for /watch - Discord doesn't support true command aliases, so
// this is a separate registration sharing the same logic, autocomplete
// included (an option's autocomplete is per-registration, so it has to be
// declared here too rather than inherited).
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
