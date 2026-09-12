import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';

// Discord caps a command's own description at 100 characters, which isn't
// enough to fully explain some of these - so /help has its own fuller,
// hand-written text rather than reusing each command's `data.description`.
const COMMANDS = [
  '**/ping** - Health check. Replies with pong and the round-trip latency.',
  '**/list** - Lists PlayTak games currently in progress, with board size, time control, and rated/unrated.',
  '**/watch <game>** (also **/spectate**) - Follows a live PlayTak game: opens a thread (or reuses ' +
    'one already watching it) and posts the board plus each move, in PTN notation, as it happens. `<game>` can be a ' +
    'game ID or a player name - partial names work too and match anywhere in the name, not just the start ' +
    '(e.g. "ppl" matches "gruppler"), but if it matches more than one active game you\'ll be asked to be more ' +
    'specific. Leave `<game>` blank to just see the active game list, same as `/list`. Moves from before the watch ' +
    'started (or missed during a long disconnect) appear as "Moves ..." text summaries - `/expand` can draw their boards.',
  '**/expand here|new** - Run inside a game thread to draw the boards its "Moves ..." catch-up summaries ' +
    "skipped. `here` edits each summary in place, attaching that stretch's board images (up to 10 per summary). " +
    '`new` builds a separate replay thread showing every move and board of the game so far, then keeps following ' +
    'the live game there too. Very long games are capped for `new` - use the ptn.ninja link posted at game end instead.',
  '**/seeks** - Lists open public seeks on PlayTak - games anyone can join right now. Private challenges aimed ' +
    'at a specific opponent are left out, since only that person can accept them.',
  '**/help** - Shows this list.',
];

const MOD_COMMANDS = [
  '**/announce <on|off|quiet|noguest|users>** - Turn `on` or `off` the announcements of new seeks from human ' +
    'players and watchable games. `quiet` - only new seeks are displayed. `noguest` - only shows live games without ' +
    'guests. `users` - only shows games with at least one registered PlayTak user.',
  '**/showbots <on|off>** - Show or hide bot games in announcements here (default on). No argument checks status.',
  '**/rating [human] [bot] [off]** - Only announce games featuring a human rated at least `human` - versus ' +
    'another human, or versus a bot rated at least `bot`. Everything else is hidden, overriding /showbots and ' +
    'the /announce mode (quiet still wins). No argument checks status; `off` clears it.',
  '**/prune duplicates** - Collapses duplicate watch threads for the same game down to one, keeping the live ' +
    'thread or whichever has more messages. Skips (and reports) any set where a human posted.',
  "**/prune threads** - Removes watch threads that no longer match this channel's current /announce/showbots/" +
    'rating settings, plus threads nobody ever chatted in that are over a day old (/expand new replay threads ' +
    'included). Live games are never touched; removed threads with human messages are flagged.',
  '**/prune messages** - Removes channel messages that no longer match current rules, game notices, ' +
    '"started a thread" lines, and /watch links whose thread is gone (over a day old), old public replies from ' +
    'commands that now reply privately, and outdated /announce status replies.',
];

// Discord rejects any single message body over 2000 characters. Each labeled
// section is sent as its own message already comfortably under that, but
// still packed/split defensively rather than assumed safe, so this can't
// silently break again the next time a line is added.
const DISCORD_MESSAGE_LIMIT = 1900;

function chunk(header: string, entries: string[]): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const entry of entries) {
    const withEntry = `${current}\n${entry}`;
    if (withEntry.length > DISCORD_MESSAGE_LIMIT && current !== header) {
      chunks.push(current);
      current = `${header}\n${entry}`;
    } else {
      current = withEntry;
    }
  }
  chunks.push(current);
  return chunks;
}

const COMMAND_CHUNKS = chunk('**Commands**', COMMANDS);
const MOD_COMMAND_CHUNKS = chunk('**Mod Commands** (require Manage Channels)', MOD_COMMANDS);

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List available commands, aliases, and what they do');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({ content: COMMAND_CHUNKS[0], flags: MessageFlags.Ephemeral });
  for (const chunk of COMMAND_CHUNKS.slice(1)) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
  }

  // Same permission /announce, /showbots, /rating, and /prune already
  // require to run - checked directly rather than trusting the invite-time
  // default, since a server's admins can loosen or tighten any command's
  // permission per-server without this ever being redeployed to match.
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;
  if (!isMod) return;

  for (const chunk of MOD_COMMAND_CHUNKS) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
  }
}
