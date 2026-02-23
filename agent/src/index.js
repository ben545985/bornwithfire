const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const CHANNEL_NAME = 'bornwithfire';
const MODEL = 'claude-sonnet-4-20250514';
const SOUL_PATH = path.resolve(__dirname, '../SOUL.md');
const MAX_MESSAGES = 20;
const TIMEOUT_MS = 30 * 60 * 1000;

const anthropic = new Anthropic();
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

  const userId = message.author.id;
  const messages = getHistory(userId);
  messages.push({ role: 'user', content: message.content });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt(),
      messages,
    });

    const reply = response.content[0].text;
    const { input_tokens, output_tokens } = response.usage;
    console.log(`[tokens] user=${userId} in=${input_tokens} out=${output_tokens}`);

    pushHistory(userId, 'user', message.content);
    pushHistory(userId, 'assistant', reply);

    await message.reply(reply);
  } catch (err) {
    console.error('[Claude API error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

client.login(process.env.DISCORD_TOKEN);
