const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createSessionManager } = require('./session-manager');

const CHANNEL_NAME = 'bornwithfire';
const DEBUG_CHANNEL_NAME = 'bwf-debug';
const EVOLUTION_CHANNEL_NAME = 'bwf-evolution';
const COMPRESSOR_PATH = path.resolve(__dirname, '../COMPRESSOR_PROMPT.md');
const manager = createSessionManager();
const startTime = Date.now();

const RATE_LIMIT_MAX = 10;       // max messages
const RATE_LIMIT_WINDOW = 60000; // per 60 seconds
const rateLimits = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const timestamps = (rateLimits.get(userId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) return false;
  timestamps.push(now);
  rateLimits.set(userId, timestamps);
  return true;
}

let debugChannel = null;
let evolutionChannel = null;

// Track users waiting for /edit-compressor input
const editCompressorPending = new Set();

const DISCORD_MAX_LENGTH = 2000;

async function sendLongReply(message, text) {
  if (text.length <= DISCORD_MAX_LENGTH) {
    return message.reply(text);
  }
  // Split into chunks, prefer splitting at newlines
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH / 2) splitAt = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  await message.reply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await message.channel.send(chunks[i]);
  }
}

function sendDebug(lines) {
  if (!debugChannel) return;
  const text = lines.join('\n');
  debugChannel.send(text).catch((err) => {
    console.error('[debug channel] send error:', err.message);
  });
}

function sendEvolution(lines) {
  if (!evolutionChannel) return;
  const text = lines.join('\n');
  evolutionChannel.send(text).catch((err) => {
    console.error('[evolution channel] send error:', err.message);
  });
}

// Auto-compress callback
manager.external.setAutoCompressCallback((userId, result) => {
  if (result.type === 'cleared') {
    sendDebug([`🕐 自动清空 — 用户 ${userId} (${result.count} 条消息，少于3条)`]);
  } else if (result.type === 'compressed') {
    sendDebug([
      `🕐 自动压缩 — 用户 ${userId}`,
      `  ${result.count} 条消息 → ${result.filename}`,
      `  摘要: ${result.summary.slice(0, 80)}...`,
      `  事实: ${result.facts.length} 条`,
    ]);
  }
});

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

  evolutionChannel = client.channels.cache.find(
    (ch) => ch.name === EVOLUTION_CHANNEL_NAME && ch.isTextBased()
  );
  if (evolutionChannel) {
    console.log(`[evolution] Found evolution channel: #${EVOLUTION_CHANNEL_NAME}`);
  } else {
    console.warn(`[evolution] Warning: #${EVOLUTION_CHANNEL_NAME} channel not found. Evolution output disabled.`);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.name !== CHANNEL_NAME) {
    console.log(`[ignored] channel=${message.channel.name || 'DM'} user=${message.author.id}`);
    return;
  }

  const content = message.content.trim();
  const cmd = content.toLowerCase();
  const userId = message.author.id;

  if (!checkRateLimit(userId)) {
    return message.reply('发送太频繁，请稍等片刻再试。');
  }

  // Handle /edit-compressor pending input (multi-step interaction, kept separate)
  if (editCompressorPending.has(userId)) {
    editCompressorPending.delete(userId);
    if (cmd === '/cancel') {
      return message.reply('已取消编辑。');
    }
    fs.writeFileSync(COMPRESSOR_PATH, content + '\n');
    sendDebug([`✏️ /edit-compressor — 用户 ${userId} 更新了压缩员规则`]);
    return message.reply('压缩员规则已更新。');
  }

  // /edit-compressor: multi-step interaction, kept as special case
  if (cmd === '/edit-compressor') {
    const current = fs.readFileSync(COMPRESSOR_PATH, 'utf-8').trim();
    editCompressorPending.add(userId);
    return message.reply(`当前压缩员规则：\n\`\`\`\n${current}\n\`\`\`\n回复新的压缩规则，或输入 /cancel 取消。`);
  }

  // === All other input → unified handleMessage ===
  try {
    const imageUrls = [...message.attachments.values()]
      .filter((a) => a.contentType && a.contentType.startsWith('image/'))
      .map((a) => a.url);
    const { reply, debug, dissatisfied, statusBar, cumulative } = await manager.handleMessage(
      userId, content, imageUrls, { startTime, sendEvolution }
    );
    const debugLines = [`📨 用户: ${content.slice(0, 50)}`, ...debug];
    if (cumulative) debugLines.push(`📈 本轮累计: input ${cumulative.inputTokens.toLocaleString()}tk output ${cumulative.outputTokens.toLocaleString()}tk (${cumulative.turns}轮)`);
    sendDebug(debugLines);
    const fullReply = statusBar ? reply + '\n\n' + statusBar : reply;
    await sendLongReply(message, fullReply);

    if (dissatisfied) {
      sendEvolution([`⚠️ 检测到不满信号 — 用户 ${userId}: "${content.slice(0, 80)}"`]);
      await message.reply('抱歉没能满足你的期望。要启动系统自检吗？我会分析问题并尝试改进。说"自检一下"即可。');
    }
  } catch (err) {
    console.error('[error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

// Save history on graceful shutdown
process.on('SIGTERM', () => {
  console.log('[shutdown] Saving history before exit...');
  manager.external.saveHistory();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[shutdown] Saving history before exit...');
  manager.external.saveHistory();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
