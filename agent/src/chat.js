const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

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

  async function reply(userId, userMessage) {
    const messages = getHistory(userId);
    messages.push({ role: 'user', content: userMessage });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt(),
      messages,
    });

    const text = response.content[0].text;
    const { input_tokens, output_tokens } = response.usage;
    console.log(`[tokens] user=${userId} in=${input_tokens} out=${output_tokens}`);

    pushHistory(userId, 'user', userMessage);
    pushHistory(userId, 'assistant', text);

    return text;
  }

  return { reply, getHistory, pushHistory, clearHistory };
}

module.exports = { createChat };
