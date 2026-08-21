import { Client, GatewayIntentBits, Collection, ChatInputCommandInteraction } from 'discord.js';
import dotenv from 'dotenv';
import * as ping from './commands/ping';
import * as list from './commands/list';
import * as watch from './commands/watch';
import * as help from './commands/help';
import * as seeks from './commands/seeks';
import * as s from './commands/s';
import * as seek from './commands/seek';
import * as l from './commands/l';
import * as w from './commands/w';
import { initPlaytak } from './playtak/shared';
import { registerWatcher } from './playtak/watcher';

dotenv.config();

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('DISCORD_TOKEN must be set in .env');
}

// Intents declare which events Discord will send us. Keep this list minimal -
// request more only as you actually need them (e.g. GuildMembers, MessageContent).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// A simple in-memory registry of commands, keyed by name, so the
// interactionCreate handler below can look up and run the right one.
interface Command {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands = new Collection<string, Command>();
commands.set(ping.data.name, ping);
commands.set(list.data.name, list);
commands.set(watch.data.name, watch);
commands.set(help.data.name, help);
commands.set(seeks.data.name, seeks);
commands.set(s.data.name, s);
commands.set(seek.data.name, seek);
commands.set(l.data.name, l);
commands.set(w.data.name, w);

client.once('ready', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  const { client: playtak, gameRegistry } = initPlaytak();
  registerWatcher(playtak, readyClient, gameRegistry);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error running command ${interaction.commandName}:`, err);
    const errorReply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorReply);
    } else {
      await interaction.reply(errorReply);
    }
  }
});

client.login(DISCORD_TOKEN);
