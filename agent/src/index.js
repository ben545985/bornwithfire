const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createChat } = require('./chat');

const CHANNEL_NAME = 'bornwithfire';
const chat = createChat();

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

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== CHANNEL_NAME) return;

  try {
    const imageUrls = [...message.attachments.values()]
      .filter((a) => a.contentType && a.contentType.startsWith('image/'))
      .map((a) => a.url);
    const reply = await chat.reply(message.author.id, message.content, imageUrls);
    await message.reply(reply);
  } catch (err) {
    console.error('[Claude API error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

client.login(process.env.DISCORD_TOKEN);
