import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

// Discord caps a command's own description at 100 characters, which isn't
// enough to fully explain some of these - so /help has its own fuller,
// hand-written text rather than reusing each command's `data.description`.
const HELP_TEXT = [
  '**/ping** - Health check. Replies with pong and the round-trip latency.',
  '**/list** - Lists PlayTak games currently in progress, with board size, time control, and rated/unrated.',
  '**/watch <game>** (also **/spectate**) - Follows a live PlayTak game: opens a thread (or reuses ' +
    'one already watching it) and posts the board plus each move, in PTN notation, as it happens. `<game>` can be a ' +
    'game ID or a player name - partial names work too and match anywhere in the name, not just the start ' +
    '(e.g. "ppl" matches "gruppler"), but if it matches more than one active game you\'ll be asked to be more ' +
    'specific. Leave `<game>` blank to just see the active game list, same as `/list`.',
  '**/seeks** - Lists open public seeks on PlayTak - games anyone can join right now. Private challenges aimed ' +
    'at a specific opponent are left out, since only that person can accept them.',
  '**/announce <on|off|quiet>** - Turns a live list of open public seeks on or off here; leave the argument ' +
    'blank to check the current status. While on, I post here when a human opens a seek and delete that message ' +
    'once it is taken or cancelled - so what you see is what you can actually join. I also post a notice with a ' +
    'Watch button when a seek (or a private challenge, like a rematch) turns into a live game, switching to ' +
    'Review once that game ends. `quiet` keeps the seek list but turns off those game-started notices. Bot ' +
    'seeks are skipped entirely; private challenges skip the seek post but can still trigger a game-started ' +
    'notice. Restricted to members with Manage Channels by default; change who can run it under Server ' +
    'Settings -> Integrations.',
  '**/help** - Shows this list.',
].join('\n\n');

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List available commands, aliases, and what they do');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply(HELP_TEXT);
}
