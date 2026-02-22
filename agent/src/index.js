const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const CHANNEL_NAME = 'bornwithfire';
const MODEL = 'claude-sonnet-4-20250514';
const SOUL_PATH = path.resolve(__dirname, '../SOUL.md');

const anthropic = new Anthropic();

function loadSystemPrompt() {
  return fs.readFileSync(SOUL_PATH, 'utf-8').trim();
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

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt(),
      messages: [{ role: 'user', content: message.content }],
    });

    const reply = response.content[0].text;
    const { input_tokens, output_tokens } = response.usage;
    console.log(`[tokens] in=${input_tokens} out=${output_tokens}`);

    await message.reply(reply);
  } catch (err) {
    console.error('[Claude API error]', err.message);
    await message.reply('出了点问题，稍后再试');
  }
});

client.login(process.env.DISCORD_TOKEN);
