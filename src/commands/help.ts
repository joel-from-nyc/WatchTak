import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

// Discord caps a command's own description at 100 characters, which isn't
// enough to fully explain some of these - so /help has its own fuller,
// hand-written text rather than reusing each command's `data.description`.
const HELP_TEXT = [
  '**/ping** - Health check. Replies with pong and the round-trip latency.',
  '**/list** (alias **/l**) - Lists PlayTak games currently in progress, with board size, time control, and rated/unrated.',
  '**/watch <game>** (alias **/w**) - Watches a live PlayTak game: opens a thread (or reuses one already watching it) ' +
    'and posts the board plus each move, in PTN notation, as it happens. `<game>` can be a game ID or a player name - ' +
    'partial names work too (e.g. "grup" matches "gruppler"), but if it matches more than one active game you\'ll be ' +
    'asked to be more specific. Leave `<game>` blank to just see the active game list, same as `/list`.',
  '**/seeks** (aliases **/s**, **/seek**) - Lists open public seeks on PlayTak - games anyone can join right now. ' +
    'Private seeks aimed at a specific opponent are left out since only that person can accept them.',
  '**/help** - Shows this list.',
].join('\n\n');

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List available commands, aliases, and what they do');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply(HELP_TEXT);
}
