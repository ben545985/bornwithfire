const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const internal = require('./internal');

const MODEL = 'claude-sonnet-4-20250514';
const SOUL_PATH = path.resolve(__dirname, '../../SOUL.md');
const COMPRESSOR_PATH = path.resolve(__dirname, '../../COMPRESSOR_PROMPT.md');
const SESSION_DIR = path.resolve(__dirname, '../../library/sessions');
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
      entry = { messages: [], lastTime: Date.now() };
      history.set(userId, entry);
    }
    entry.messages.push({ role, content });
    entry.lastTime = Date.now();
    if (entry.messages.length > MAX_MESSAGES) {
      entry.messages = entry.messages.slice(-MAX_MESSAGES);
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
      const filename = `session-${ts}.md`;
      const factsSection = result.facts.length > 0
        ? '\n\n## 提取的事实\n' + result.facts.map((f) => `- ${f}`).join('\n')
        : '';
      const fileContent = `---\ntags: 对话记录, 自动压缩\nsummary: ${result.summary.slice(0, 50)}\n---\n${result.summary}${factsSection}\n`;
      fs.writeFileSync(path.join(SESSION_DIR, filename), fileContent);

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

  async function reply(userId, userMessage, context, imageUrls) {
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

    const content = contentBlocks.length === 1 && contentBlocks[0].type === 'text'
      ? userMessage
      : contentBlocks;

    messages.push({ role: 'user', content });

    // Merge context: fullload takes priority, then normal context
    let mergedContext = context || '';
    const fl = fullloadContext.get(userId);
    if (fl) {
      mergedContext = fl + (mergedContext ? '\n\n' + mergedContext : '');
      fullloadContext.delete(userId);
    }

    let systemPrompt = loadSystemPrompt();
    if (mergedContext) {
      systemPrompt += '\n\n以下是系统为你检索并精炼的相关资料：\n' + mergedContext;
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const text = response.content[0].text;
    const { input_tokens, output_tokens } = response.usage;
    console.log(`[external] Sonnet called, tokens in=${input_tokens} out=${output_tokens}`);

    const historyText = imageUrls && imageUrls.length > 0
      ? `[用户发送了${imageUrls.length}张图片] ${userMessage || ''}`
      : userMessage;
    pushHistory(userId, 'user', historyText);
    pushHistory(userId, 'assistant', text);

    resetTimer(userId);

    return { text, contextLen: mergedContext ? mergedContext.length : 0, input_tokens, output_tokens };
  }

  return { reply, getHistory, pushHistory, clearHistory, historyCount, compress, setFullloadContext, setAutoCompressCallback };
}

module.exports = { createExternal };
