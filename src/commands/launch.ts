import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { randomUUID } from 'crypto';
import { registerSession } from '../sessionStore';

export const data = new SlashCommandBuilder()
  .setName('launch')
  .setDescription('Starts a game session on the website and posts a join link');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  // In a real version, this is where you'd call your website's API, e.g.:
  //
  //   const res = await fetch('https://your-game-site.com/api/sessions', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ startedBy: interaction.user.id }),
  //   });
  //   const { sessionId, joinUrl } = await res.json();
  //
  // For this proof of concept we just fake it locally so you can see the
  // full round trip (Discord -> "website" -> back to Discord) without
  // needing a real website yet.
  const sessionId = randomUUID();
  const joinUrl = `https://your-game-site.example.com/join/${sessionId}`;

  // Remember which channel this session belongs to, so when the website
  // later calls our webhook (e.g. "player joined", "game started"), we
  // know where in Discord to post the update.
  registerSession(sessionId, interaction.channelId);

  await interaction.editReply(
    `Game session started! Click to join: ${joinUrl}\n` +
      `(session id: \`${sessionId}\` — the website should call our webhook with this ID to post updates here)`
  );
}
