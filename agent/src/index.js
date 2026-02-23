const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createSessionManager } = require('./session-manager');
const { loadLibrary, getAllSummaries, getFileContent, getRawFileContent } = require('./library');

const CHANNEL_NAME = 'bornwithfire';
const DEBUG_CHANNEL_NAME = 'bwf-debug';
const EVOLUTION_CHANNEL_NAME = 'bwf-evolution';
const COMPRESSOR_PATH = path.resolve(__dirname, '../COMPRESSOR_PROMPT.md');
const manager = createSessionManager();
const startTime = Date.now();

let debugChannel = null;
let evolutionChannel = null;

// Track users waiting for /edit-compressor input
const editCompressorPending = new Set();

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
  if (message.channel.name !== CHANNEL_NAME) return;

  const content = message.content.trim();
  const cmd = content.toLowerCase();
  const userId = message.author.id;

  // Handle /edit-compressor pending input
  if (editCompressorPending.has(userId)) {
    editCompressorPending.delete(userId);
    if (cmd === '/cancel') {
      return message.reply('已取消编辑。');
    }
    fs.writeFileSync(COMPRESSOR_PATH, content + '\n');
    sendDebug([`✏️ /edit-compressor — 用户 ${userId} 更新了压缩员规则`]);
    return message.reply('压缩员规则已更新。');
  }

  // === Commands ===

  if (cmd === '/reset') {
    manager.external.clearHistory(userId);
    sendDebug([`🔄 /reset — 用户 ${userId} 对话已重置`]);
    return message.reply('对话已重置。');
  }

  if (cmd === '/compress') {
    try {
      const { count, summary, facts } = await manager.external.compress(userId);
      if (count === 0) {
        sendDebug([`📎 /compress — 用户 ${userId} 无历史可压缩`]);
        return message.reply('当前没有对话历史可压缩。');
      }
      const factsInfo = facts && facts.length > 0 ? `\n提取了 ${facts.length} 条关键事实。` : '';
      sendDebug([`📎 /compress — 用户 ${userId} 压缩了 ${count} 条消息 (DeepSeek)`]);
      return message.reply(`对话已压缩。之前 ${count} 条消息压缩为摘要。${factsInfo}`);
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

  if (cmd.startsWith('/fullload ')) {
    const filename = content.slice(10).trim();
    if (!filename) return message.reply('用法：/fullload 文件名.md');
    const file = getRawFileContent(filename);
    if (!file) {
      return message.reply('文件不存在。输入 /library 查看可用文件。');
    }
    manager.external.setFullloadContext(userId, file.content);
    sendDebug([`📥 /fullload — 用户 ${userId} 加载了 ${filename} (${file.content.length}字)`]);
    return message.reply(`已加载 ${filename}（${file.content.length} 字）到当前对话上下文。`);
  }

  if (cmd === '/library') {
    const summaries = getAllSummaries();
    if (summaries.length === 0) {
      return message.reply('📚 图书馆为空。');
    }
    const lines = summaries.map((s) => `• ${s.filename} — ${s.summary || '无描述'}`);
    sendDebug([`📚 /library — 用户 ${userId}`]);
    return message.reply(`📚 图书馆文件列表：\n${lines.join('\n')}`);
  }

  if (cmd === '/evolve') {
    try {
      const result = await manager.handleEvolve(userId);
      const evoLines = [
        '⚠️ 用户不满事件',
        `🔍 诊断员：${result.diagnosis}`,
        `💡 方案员：${result.proposal}`,
      ];

      // One-time action
      if (result.oneTimeAction !== 'none') {
        evoLines.push(`⚡ 一次性操作：${result.oneTimeResult}`);
      }

      // System suggestion → only to #bwf-evolution for human review
      if (result.systemSuggestion !== 'none') {
        evoLines.push(`📋 系统改进建议（需人类审批）：\n${result.systemSuggestion}`);
      }

      sendEvolution(evoLines);
      sendDebug([`🔧 /evolve — 用户 ${userId}`]);

      let replyText = `自检完成：\n🔍 诊断：${result.diagnosis}\n💡 建议：${result.proposal}`;
      if (result.oneTimeAction !== 'none') {
        replyText += `\n⚡ 已执行：${result.oneTimeResult}`;
      }
      if (result.systemSuggestion !== 'none') {
        replyText += `\n📋 系统改进建议已提交到 #bwf-evolution，等待管理员审批。`;
      }
      return message.reply(replyText);
    } catch (err) {
      console.error('[evolve error]', err.message);
      return message.reply('自检失败，稍后再试');
    }
  }

  if (cmd === '/edit-compressor') {
    const current = fs.readFileSync(COMPRESSOR_PATH, 'utf-8').trim();
    editCompressorPending.add(userId);
    return message.reply(`当前压缩员规则：\n\`\`\`\n${current}\n\`\`\`\n回复新的压缩规则，或输入 /cancel 取消。`);
  }

  // === Normal message ===
  try {
    const imageUrls = [...message.attachments.values()]
      .filter((a) => a.contentType && a.contentType.startsWith('image/'))
      .map((a) => a.url);
    const { reply, debug, dissatisfied } = await manager.handleMessage(userId, content, imageUrls);
    sendDebug([`📨 用户: ${content.slice(0, 50)}`, ...debug]);
    await message.reply(reply);

    if (dissatisfied) {
      sendEvolution([`⚠️ 检测到不满信号 — 用户 ${userId}: "${content.slice(0, 80)}"`]);
      await message.reply('抱歉没能满足你的期望。要启动系统自检吗？我会分析问题并尝试改进。输入 /evolve 确认。');
    }
  } catch (err) {
    console.error('[error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

client.login(process.env.DISCORD_TOKEN);
