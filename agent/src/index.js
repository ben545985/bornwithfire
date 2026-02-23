const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createChat } = require('./chat');
const { loadLibrary } = require('./library');

const CHANNEL_NAME = 'bornwithfire';
const chat = createChat();
const startTime = Date.now();

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

  const cmd = message.content.trim().toLowerCase();
  const userId = message.author.id;

  if (cmd === '/reset') {
    chat.clearHistory(userId);
    return message.reply('对话已重置。');
  }

  if (cmd === '/compress') {
    try {
      const { count, summary } = await chat.compress(userId);
      if (count === 0) return message.reply('当前没有对话历史可压缩。');
      return message.reply(`对话已压缩。之前 ${count} 条消息压缩为摘要。`);
    } catch (err) {
      console.error('[compress error]', err.message);
      return message.reply('压缩失败，稍后再试');
    }
  }

  if (cmd === '/status') {
    const msgCount = chat.historyCount(userId);
    const libCount = loadLibrary().length;
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    return message.reply(
      `对话历史：${msgCount} 条\n图书馆文件：${libCount} 个\nBot 运行时间：${hours}小时${minutes}分钟`
    );
  }

  try {
    const imageUrls = [...message.attachments.values()]
      .filter((a) => a.contentType && a.contentType.startsWith('image/'))
      .map((a) => a.url);
    const reply = await chat.reply(userId, message.content, imageUrls);
    await message.reply(reply);
  } catch (err) {
    console.error('[Claude API error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

client.login(process.env.DISCORD_TOKEN);
