import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';

export const data = new SlashCommandBuilder().setName('ping').setDescription('Replies with pong and the bot latency');

export async function execute(interaction: ChatInputCommandInteraction) {
  const response = await interaction.reply({
    content: 'Pinging...',
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });
  const sentAt = response.resource?.message?.createdTimestamp ?? Date.now();
  const latency = sentAt - interaction.createdTimestamp;
  await interaction.editReply(`Pong! Latency: ${latency}ms`);
}
