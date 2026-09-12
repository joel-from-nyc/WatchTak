import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';

// Discord caps a command's own description at 100 characters, which isn't
// enough to fully explain some of these - so /help has its own fuller,
// hand-written text rather than reusing each command's `data.description`.
const COMMANDS = [
  '**/ping** - Bot health check. Replies with round-trip latency.',
  '**/list** - Lists PlayTak games currently in progress.',
  '**/watch <PlayTakGame#>** or **<player_name>** (also **/spectate**) - Follows a live PlayTak game in a thread. ' +
    'Partial name matches work.',
  '**/expand here** or **new** - Use this inside a game thread to draw the boards and "catch-up" on any missed ' +
    'moves from before the thread started. Either in an existing thread or a new one.',
  '**/seeks** - Lists open public seeks on PlayTak',
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
  '**/prune messages** - Removes channel messages that no longer match current rules, game notices and ' +
    '"started a thread" lines whose thread is gone (over a day old), plus old public replies from any command that ' +
    'now replies privately (/ping, /list, /seeks, /help, /showbots, /rating, /prune, /expand).',
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

const COMMAND_CHUNKS = chunk('**WatchTak Commands**', COMMANDS);
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
