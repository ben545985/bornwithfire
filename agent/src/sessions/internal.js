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
  const usage = response.usage || {};
  console.log(`[internal:recall] DeepSeek returned: ${text}`);

  let filenames;
  try {
    filenames = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    filenames = match ? JSON.parse(match[0]) : [];
  }

  return { filenames, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } };
}

async function extract(userMessage, fileContents, maxChars) {
  const inputLen = fileContents.length;
  const limit = maxChars || 300;

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `用户问的是下面这个问题。从提供的资料中，只提取跟这个问题直接相关的信息，用中文精简输出，不超过 ${limit} 字。不要加解释、不要加前缀、不要编造。如果资料中没有相关内容，只输出"无相关内容"。`,
      },
      {
        role: 'user',
        content: `问题：${userMessage}\n\n资料：\n${fileContents}`,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  const usage = response.usage || {};
  console.log(`[internal:extract] compressed ${inputLen} chars → ${text.length} chars`);

  return { text, inputLen, outputLen: text.length, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } };
}

async function compress(messages, compressorPrompt) {
  const chatText = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n\n');

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: compressorPrompt },
      { role: 'user', content: chatText },
    ],
  });

  const text = response.choices[0].message.content.trim();
  const usage = response.usage || {};
  console.log(`[internal:compress] DeepSeek compressed ${messages.length} messages`);

  try {
    const parsed = JSON.parse(text);
    return {
      summary: parsed.summary || '',
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    };
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || '',
          facts: Array.isArray(parsed.facts) ? parsed.facts : [],
          usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
        };
      } catch { /* fall through */ }
    }
    return {
      summary: text.slice(0, 200),
      facts: [],
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    };
  }
}

async function diagnose(complaint, chatHistory, debugLog) {
  const historyText = chatHistory
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
    .join('\n');

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '你是系统诊断员。用户不满意，分析问题出在哪一步。可能的原因：关键词未匹配、回忆员未找到、提取员丢失关键信息、压缩员之前丢弃了重要事实、图书馆缺少相关文件。只输出诊断结论，100字以内。',
      },
      {
        role: 'user',
        content: `用户不满内容：${complaint}\n\n对话历史：\n${historyText}\n\n调试日志：\n${debugLog}`,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

async function propose(diagnosis) {
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '你是方案员。根据诊断结论，提出具体修改建议。建议类型：新增 tag、新建 md 文件、修改压缩员规则、调整关键词匹配逻辑。只输出建议，150字以内。',
      },
      {
        role: 'user',
        content: `诊断结论：${diagnosis}`,
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

async function judge(diagnosis, proposal) {
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '你是裁判员。评估诊断和建议方案。你可以批准以下操作：建议新增 tag、建议新建空 md 文件。你不能批准：修改 SOUL.md、删除文件、修改 COMPRESSOR_PROMPT.md（需人类审批）。输出 JSON：{ "decision": "approve/reject/human_review", "action": "具体操作描述", "reason": "理由" }',
      },
      {
        role: 'user',
        content: `诊断：${diagnosis}\n\n建议方案：${proposal}`,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return { decision: 'human_review', action: text, reason: '无法解析裁判员输出' };
  }
}

module.exports = { recall, extract, compress, diagnose, propose, judge };
