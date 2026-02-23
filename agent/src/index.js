const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createSessionManager } = require('./session-manager');
const { loadLibrary } = require('./library');

const CHANNEL_NAME = 'bornwithfire';
const DEBUG_CHANNEL_NAME = 'bwf-debug';
const manager = createSessionManager();
const startTime = Date.now();

let debugChannel = null;

function sendDebug(lines) {
  if (!debugChannel) return;
  const text = lines.join('\n');
  debugChannel.send(text).catch((err) => {
    console.error('[debug channel] send error:', err.message);
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log('Bot online');

  debugChannel = client.channels.cache.find(
    (ch) => ch.name === DEBUG_CHANNEL_NAME && ch.isTextBased()
  );
  if (debugChannel) {
    console.log(`[debug] Found debug channel: #${DEBUG_CHANNEL_NAME}`);
  } else {
    console.warn(`[debug] Warning: #${DEBUG_CHANNEL_NAME} channel not found. Debug output disabled.`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== CHANNEL_NAME) return;

  const content = message.content.trim();
  const cmd = content.toLowerCase();
  const userId = message.author.id;

  if (cmd === '/reset') {
    manager.external.clearHistory(userId);
    sendDebug([`🔄 /reset — 用户 ${userId} 对话已重置`]);
    return message.reply('对话已重置。');
  }

  if (cmd === '/compress') {
    try {
      const { count } = await manager.external.compress(userId);
      if (count === 0) {
        sendDebug([`📎 /compress — 用户 ${userId} 无历史可压缩`]);
        return message.reply('当前没有对话历史可压缩。');
      }
      sendDebug([`📎 /compress — 用户 ${userId} 压缩了 ${count} 条消息`]);
      return message.reply(`对话已压缩。之前 ${count} 条消息压缩为摘要。`);
    } catch (err) {
      console.error('[compress error]', err.message);
      return message.reply('压缩失败，稍后再试');
    }
  }

  if (cmd === '/status') {
    const msgCount = manager.external.historyCount(userId);
    const libCount = loadLibrary().length;
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    sendDebug([`📊 /status — 用户 ${userId}`]);
    return message.reply(
      `对话历史：${msgCount} 条\n图书馆文件：${libCount} 个\nBot 运行时间：${hours}小时${minutes}分钟`
    );
  }

  if (cmd.startsWith('/recall ')) {
    const query = content.slice(8).trim();
    if (!query) return message.reply('用法：/recall <问题>');
    try {
      const { reply, debug } = await manager.handleRecall(userId, query);
      sendDebug([`📨 /recall: ${query.slice(0, 50)}`, ...debug]);
      return message.reply(reply);
    } catch (err) {
      console.error('[recall error]', err.message);
      return message.reply('回忆失败，稍后再试');
    }
  }

  try {
    const imageUrls = [...message.attachments.values()]
      .filter((a) => a.contentType && a.contentType.startsWith('image/'))
      .map((a) => a.url);
    const { reply, debug } = await manager.handleMessage(userId, content, imageUrls);
    sendDebug([`📨 用户: ${content.slice(0, 50)}`, ...debug]);
    await message.reply(reply);
  } catch (err) {
    console.error('[error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

client.login(process.env.DISCORD_TOKEN);
