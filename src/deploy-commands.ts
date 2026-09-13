import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
import { commands as commandList } from './commands';

// Same env-file argument as index.ts.
const envFile = process.argv[2] ?? '.env';
dotenv.config({ path: envFile });

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error(`DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in ${envFile}`);
}

console.log(`Using ${envFile} - guild ${DISCORD_GUILD_ID ?? '(none, global)'}`);

const commands = commandList.map((command) => command.data.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);

async function main() {
  // Guild-scoped registration takes effect immediately; global registration
  // can take up to an hour to propagate.
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID!, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID!);

  console.log(`Registering ${commands.length} command(s)...`);
  await rest.put(route, { body: commands });
  console.log('Commands registered successfully.');

  // Clear any global registration so commands do not appear twice.
  if (DISCORD_GUILD_ID) {
    console.log('Clearing old global commands...');
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID!), { body: [] });
    console.log('Old global commands cleared.');
  }
}

main().catch((err) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});
