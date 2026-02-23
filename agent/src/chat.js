const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const { search } = require('./library');

const MODEL = 'claude-sonnet-4-20250514';
const SOUL_PATH = path.resolve(__dirname, '../SOUL.md');
const MAX_MESSAGES = 20;
const TIMEOUT_MS = 30 * 60 * 1000;

function createChat(anthropicClient) {
  const client = anthropicClient || new Anthropic();
  const history = new Map();

  function loadSystemPrompt() {
    return fs.readFileSync(SOUL_PATH, 'utf-8').trim();
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
  }

  async function reply(userId, userMessage, imageUrls) {
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

    let systemPrompt = loadSystemPrompt();
    const libraryHits = search(userMessage || '');
    if (libraryHits.length > 0) {
      systemPrompt += '\n\n以下是相关背景资料：\n' + libraryHits.join('\n\n');
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const text = response.content[0].text;
    const { input_tokens, output_tokens } = response.usage;
    console.log(`[tokens] user=${userId} in=${input_tokens} out=${output_tokens}`);

    const historyText = imageUrls && imageUrls.length > 0
      ? `[用户发送了${imageUrls.length}张图片] ${userMessage || ''}`
      : userMessage;
    pushHistory(userId, 'user', historyText);
    pushHistory(userId, 'assistant', text);

    return text;
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

  async function compress(userId) {
    const messages = getHistory(userId);
    const count = messages.length;
    if (count === 0) return { count: 0 };

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: '请将以下对话总结为一段简短的中文摘要，200字以内。只输出摘要内容，不要加前缀。',
      messages: [...messages, { role: 'user', content: '请总结以上对话。' }],
    });

    const summary = response.content[0].text;
    history.set(userId, {
      messages: [{ role: 'assistant', content: '以下是我们之前的对话摘要：\n' + summary }],
      lastTime: Date.now(),
    });

    return { count, summary };
  }

  return { reply, getHistory, pushHistory, clearHistory, historyCount, compress };
}

module.exports = { createChat };
