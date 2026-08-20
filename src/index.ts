import { Client, GatewayIntentBits, Collection, ChatInputCommandInteraction } from 'discord.js';
import dotenv from 'dotenv';
import * as ping from './commands/ping';
import * as launch from './commands/launch';
import { startWebhookServer } from './server';

dotenv.config();

const { DISCORD_TOKEN, WEBHOOK_PORT, WEBHOOK_SECRET } = process.env;

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
commands.set(launch.data.name, launch);

client.once('ready', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  // Start the webhook server once we're connected, since it needs the
  // client to actually post messages.
  const port = Number(WEBHOOK_PORT ?? 3000);
  const secret = WEBHOOK_SECRET ?? 'change-me';
  startWebhookServer(client, port, secret);
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
