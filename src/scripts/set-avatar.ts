// Sets the bot's Discord avatar from a local image file, via
// ClientUser#setAvatar (a PATCH of /users/@me under the hood).
//
// Deliberately a standalone script rather than something index.ts does on
// startup: Discord rate-limits avatar changes on the order of a couple per
// hour, and this bot runs as an always-on service that gets restarted for
// every deploy - setting the avatar on boot would burn that budget for no
// reason and could lock the account out of further changes. The avatar only
// changes when someone decides to change it, so running it by hand is the
// right shape.
//
//   npm run set-avatar                       # assets/watchtak-icon.png, .env
//   npm run set-avatar -- <image> <envFile>  # explicit
//
// Discord accepts PNG, JPG, and GIF here - NOT WebP, despite it being fine
// for ordinary attachments. discord.js base64-encodes whatever bytes it's
// given and labels the data URI "image/jpg" regardless of the real format
// (see DataResolver.resolveBase64), so Discord sniffs the real content and a
// WebP is simply rejected; converting first is the answer, not relabelling.
import path from 'path';
import fs from 'fs';
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

const DEFAULT_IMAGE = path.join(__dirname, '..', '..', 'assets', 'watchtak-icon.png');
const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'];

const imagePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_IMAGE;
// Same env-file selection as index.ts/deploy-commands.ts - which bot's avatar
// this changes depends entirely on which token is loaded, so it stays
// explicit rather than always using whatever `.env` happens to hold.
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

// No intents needed: this only touches the REST user endpoint, and logging in
// is just how the token gets authenticated.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async (readyClient) => {
  try {
    const updated = await readyClient.user.setAvatar(imagePath);
    console.log(`Avatar updated for ${updated.tag}: ${updated.displayAvatarURL({ size: 512 })}`);
  } catch (err) {
    // Overwhelmingly the interesting failure here is a 429 - see the
    // rate-limit note at the top - so surface it rather than just exiting.
    console.error('Failed to set the avatar:', err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(DISCORD_TOKEN);
