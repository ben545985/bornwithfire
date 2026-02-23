const OpenAI = require('openai');

const client = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const MODEL = 'deepseek-chat';

async function recall(userMessage, summaries) {
  const fileList = summaries
    .map((s) => `- ${s.filename} [tags: ${s.tags.join(', ')}] ${s.summary}`)
    .join('\n');

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '你是文件检索助手。根据用户问题，从文件列表中选最相关的文件。只返回 JSON 数组 ["file1.md"]。没有就返回 []。不要解释。',
      },
      {
        role: 'user',
        content: `用户问题：${userMessage}\n\n文件列表：\n${fileList}`,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  console.log(`[internal:recall] DeepSeek returned: ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    return [];
  }
}

async function extract(userMessage, fileContents) {
  const inputLen = fileContents.length;

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '用户问的是下面这个问题。从提供的资料中，只提取跟这个问题直接相关的信息，用中文精简输出，不超过 300 字。不要加解释、不要加前缀、不要编造。如果资料中没有相关内容，只输出"无相关内容"。',
      },
      {
        role: 'user',
        content: `问题：${userMessage}\n\n资料：\n${fileContents}`,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  console.log(`[internal:extract] compressed ${inputLen} chars → ${text.length} chars`);
  return text;
}

module.exports = { recall, extract };
