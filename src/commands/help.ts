import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';

// Fuller text than the 100-character command descriptions allow.
const COMMANDS = [
  '**/ping** - Bot health check. Replies with round-trip latency.',
  '**/list** - Lists PlayTak games currently in progress.',
  '**/watch <PlayTakGame#>** or **<player_name>** (also **/spectate**) - Follows a live PlayTak game in a thread. ' +
    'Pick from the list that appears as you type, or type a partial name.',
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
  '**/prune messages** - Removes channel messages that no longer match current rules, game notices, ' +
    '"started a thread" lines, and /watch links whose thread is gone (over a day old), old public replies from ' +
    'commands that now reply privately, and outdated /announce status replies.',
];

// Discord rejects messages over 2000 characters; each section is split to
// stay under.
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

  // Checked live rather than trusting the registered default, since server
  // admins can change any command's permission without a redeploy.
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;
  if (!isMod) return;

  for (const chunk of MOD_COMMAND_CHUNKS) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
  }
}
