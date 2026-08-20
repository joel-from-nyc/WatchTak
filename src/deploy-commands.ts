import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import * as ping from './commands/ping';
import * as launch from './commands/launch';

dotenv.config();

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env');
}

const commands = [ping.data.toJSON(), launch.data.toJSON()];

const rest = new REST().setToken(DISCORD_TOKEN);

async function main() {
  // Guild-scoped registration shows up instantly - great for development.
  // Global registration (no guild ID) can take up to an hour to propagate,
  // but makes the commands available in every server the bot is in.
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID!, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID!);

  console.log(`Registering ${commands.length} command(s)...`);
  await rest.put(route, { body: commands });
  console.log('Commands registered successfully.');
}

main().catch((err) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
