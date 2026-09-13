// Sets the bot's Discord avatar from a local image file. Run by hand, not on
// startup: Discord rate-limits avatar changes to a few per hour.
//
//   npm run set-avatar                       # assets/watchtak-icon.png, .env
//   npm run set-avatar -- <image> <envFile>  # explicit
//
// Discord accepts PNG, JPG, and GIF avatars, not WebP.
import path from 'path';
import fs from 'fs';
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

const DEFAULT_IMAGE = path.join(__dirname, '..', '..', 'assets', 'watchtak-icon.png');
const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'];

const imagePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_IMAGE;
// Same env-file argument as index.ts.
const envFile = process.argv[3] ?? '.env';
dotenv.config({ path: envFile });

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) throw new Error(`DISCORD_TOKEN must be set in ${envFile}`);

if (!fs.existsSync(imagePath)) throw new Error(`No such image: ${imagePath}`);

const extension = path.extname(imagePath).toLowerCase();
if (!ACCEPTED_EXTENSIONS.includes(extension)) {
  throw new Error(
    `Discord won't accept a ${extension || '(no extension)'} avatar - use one of ${ACCEPTED_EXTENSIONS.join(', ')}. ` +
      'A WebP has to be converted to PNG first; see this file\'s header.',
  );
}

console.log(`Using ${envFile} - setting avatar from ${imagePath}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async (readyClient) => {
  try {
    const updated = await readyClient.user.setAvatar(imagePath);
    console.log(`Avatar updated for ${updated.tag}: ${updated.displayAvatarURL({ size: 512 })}`);
  } catch (err) {
    console.error('Failed to set the avatar:', err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(DISCORD_TOKEN);
