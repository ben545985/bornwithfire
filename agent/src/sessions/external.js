const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const internal = require('./internal');
const { invalidateCache } = require('../library');

const MODEL = 'claude-sonnet-4-6';
const SOUL_PATH = path.resolve(__dirname, '../../SOUL.md');
const COMPRESSOR_PATH = path.resolve(__dirname, '../../COMPRESSOR_PROMPT.md');
const SESSION_DIR = path.resolve(__dirname, '../../library/sessions');
const HISTORY_PATH = path.resolve(__dirname, '../../data/history.json');
const MAX_MESSAGES = 20;
const TIMEOUT_MS = 30 * 60 * 1000;

function createExternal(anthropicClient) {
  const client = anthropicClient || new Anthropic();
  const history = new Map();
  const timers = new Map();
  const fullloadContext = new Map();
  let onAutoCompress = null;

  function setAutoCompressCallback(cb) {
    onAutoCompress = cb;
  }

  function saveHistory() {
    try {
      const dir = path.dirname(HISTORY_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {};
      for (const [userId, entry] of history.entries()) {
        data[userId] = entry;
      }
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(data));
    } catch (err) {
      console.error('[history] Failed to save:', err.message);
    }
  }

  function loadHistory() {
    try {
      if (!fs.existsSync(HISTORY_PATH)) return;
      const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
      const now = Date.now();
      let restored = 0;
      for (const [userId, entry] of Object.entries(data)) {
        if (now - entry.lastTime < TIMEOUT_MS) {
          history.set(userId, entry);
          resetTimer(userId);
          restored++;
        }
      }
      if (restored > 0) console.log(`[history] Restored ${restored} active sessions from disk`);
    } catch (err) {
      console.error('[history] Failed to load:', err.message);
    }
  }

  function loadSystemPrompt() {
    return fs.readFileSync(SOUL_PATH, 'utf-8').trim();
  }

  function loadCompressorPrompt() {
    return fs.readFileSync(COMPRESSOR_PATH, 'utf-8').trim();
  }

  function getHistory(userId) {
    const entry = history.get(userId);
    if (!entry) return [];
    if (Date.now() - entry.lastTime > TIMEOUT_MS) {
      history.delete(userId);
      return [];
    }
    return entry.messages;
  }

  function pushHistory(userId, role, content) {
    let entry = history.get(userId);
    if (!entry) {
      entry = { messages: [], lastTime: Date.now(), truncated: false, cumTokens: { input: 0, output: 0, turns: 0 } };
      history.set(userId, entry);
    }
    entry.messages.push({ role, content });
    entry.lastTime = Date.now();
    if (entry.messages.length > MAX_MESSAGES) {
      entry.messages = entry.messages.slice(-MAX_MESSAGES);
      entry.truncated = true;
    }
  }

  function clearHistory(userId) {
    history.delete(userId);
    if (timers.has(userId)) {
      clearTimeout(timers.get(userId));
      timers.delete(userId);
    }
  }

  function historyCount(userId) {
    const entry = history.get(userId);
    if (!entry) return 0;
    if (Date.now() - entry.lastTime > TIMEOUT_MS) {
      history.delete(userId);
      return 0;
    }
    return entry.messages.length;
  }

  function resetTimer(userId) {
    if (timers.has(userId)) {
      clearTimeout(timers.get(userId));
    }
    timers.set(userId, setTimeout(() => {
      autoCompress(userId);
    }, TIMEOUT_MS));
  }

  async function autoCompress(userId) {
    timers.delete(userId);
    const messages = getHistory(userId);
    const count = messages.length;

    if (count < 3) {
      history.delete(userId);
      if (onAutoCompress) onAutoCompress(userId, { type: 'cleared', count });
      console.log(`[auto-compress] user=${userId} cleared (${count} messages)`);
      return;
    }

    try {
      const result = await internal.compress(messages, loadCompressorPrompt());

      // Save to library/sessions/
      if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
      }
      const now = new Date();
      const ts = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
      const rand = Math.random().toString(36).slice(2, 6);
      const filename = `session-${ts}-${userId}-${rand}.md`;
      const factsSection = result.facts.length > 0
        ? '\n\n## 提取的事实\n' + result.facts.map((f) => `- ${f}`).join('\n')
        : '';
      const fileContent = `---\ntags: 对话记录, 自动压缩\nsummary: ${result.summary.slice(0, 50)}\n---\n${result.summary}${factsSection}\n`;
      fs.writeFileSync(path.join(SESSION_DIR, filename), fileContent);
      invalidateCache();

      history.delete(userId);
      if (onAutoCompress) onAutoCompress(userId, { type: 'compressed', count, filename, summary: result.summary, facts: result.facts });
      console.log(`[auto-compress] user=${userId} compressed ${count} messages → ${filename}`);
    } catch (err) {
      console.error(`[auto-compress] error for user=${userId}:`, err.message);
      history.delete(userId);
    }
  }

  async function compress(userId) {
    const messages = getHistory(userId);
    const count = messages.length;
    if (count === 0) return { count: 0 };

    const result = await internal.compress(messages, loadCompressorPrompt());

    history.set(userId, {
      messages: [{ role: 'assistant', content: '以下是我们之前的对话摘要：\n' + result.summary }],
      lastTime: Date.now(),
    });

    return { count, summary: result.summary, facts: result.facts };
  }

  function setFullloadContext(userId, context) {
    fullloadContext.set(userId, context);
  }

  async function reply(userId, userMessage, context, imageUrls, opts) {
    const messages = getHistory(userId);

    const contentBlocks = [];
    if (imageUrls && imageUrls.length > 0) {
      for (const url of imageUrls) {
        contentBlocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
    if (userMessage) {
      contentBlocks.push({ type: 'text', text: userMessage });
    }

    // Ensure content is never empty — Claude API requires non-empty user messages
    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: '(空消息)' });
    }

    const content = contentBlocks.length === 1 && contentBlocks[0].type === 'text'
      ? (contentBlocks[0].text || '(空消息)')
      : contentBlocks;

    // Merge context: fullload takes priority, then normal context
    let mergedContext = context || '';
    const fl = fullloadContext.get(userId);
    if (fl) {
      mergedContext = fl + (mergedContext ? '\n\n' + mergedContext : '');
      fullloadContext.delete(userId);
    }

    // Build API messages separately — do NOT push to history yet, avoids
    // polluting history with array content and avoids double-push on failure
    const apiMessages = [...messages, { role: 'user', content }].filter((m) => {
      if (!m.content) return false;
      if (typeof m.content === 'string') return m.content.trim().length > 0;
      if (Array.isArray(m.content)) return m.content.length > 0;
      return true;
    });

    let systemPrompt = loadSystemPrompt();
    systemPrompt += `\n\n今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}。`;
    const entry = history.get(userId);
    if (entry && entry.truncated) {
      systemPrompt += '\n\n[注意：当前对话历史已被截断，更早的消息不可见。如果用户提到之前说过的内容而你找不到，请直接告知用户该内容已超出你的记忆范围。]';
    }
    if (mergedContext) {
      systemPrompt += '\n\n以下是系统为你检索并精炼的相关资料：\n' + mergedContext;
    }

    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: apiMessages,
      });
    } catch (err) {
      // Restore fullload context so user can retry without re-loading the file
      if (fl) fullloadContext.set(userId, fl);
      console.error(`[external] Claude API error for user=${userId}:`, err.message);
      throw err;
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    const { input_tokens, output_tokens } = response.usage;
    console.log(`[external] Sonnet called, tokens in=${input_tokens} out=${output_tokens}`);

    // Only update history after a successful API call, always as strings
    const historyText = imageUrls && imageUrls.length > 0
      ? `[用户发送了${imageUrls.length}张图片] ${userMessage || ''}`
      : userMessage;
    pushHistory(userId, 'user', historyText);
    pushHistory(userId, 'assistant', text);

    // Accumulate token counts
    const entry2 = history.get(userId);
    if (entry2) {
      if (!entry2.cumTokens) entry2.cumTokens = { input: 0, output: 0, turns: 0 };
      entry2.cumTokens.input += input_tokens;
      entry2.cumTokens.output += output_tokens;
      entry2.cumTokens.turns += 1;
    }

    resetTimer(userId);
    saveHistory();

    // Compute breakdown for status bar
    const soulLen = loadSystemPrompt().length;
    const historyLen = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const historyCount = messages.length;
    const cum = entry2 && entry2.cumTokens ? entry2.cumTokens : null;

    return {
      text, input_tokens, output_tokens,
      breakdown: {
        soul: soulLen,
        history: historyLen,
        historyCount,
        context: mergedContext ? mergedContext.length : 0,
        system: systemPrompt.length,
        inputTokens: input_tokens,
        outputTokens: output_tokens,
      },
      cumulative: cum ? { inputTokens: cum.input, outputTokens: cum.output, turns: cum.turns } : null,
    };
  }

  // Load persisted history on startup
  loadHistory();

  return { reply, getHistory, pushHistory, clearHistory, historyCount, compress, setFullloadContext, setAutoCompressCallback, saveHistory };
}

module.exports = { createExternal };
