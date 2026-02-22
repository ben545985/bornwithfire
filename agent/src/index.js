const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const CHANNEL_NAME = 'bornwithfire';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log('Bot online');
});

client.on('messageCreate', (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== CHANNEL_NAME) return;
  message.reply(`收到：${message.content}`);
});

client.login(process.env.DISCORD_TOKEN);
