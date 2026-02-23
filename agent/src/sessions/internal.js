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
        content: '你是裁判员。评估诊断和建议。你有两种权限：\n第一，一次性决策：你可以决定并执行针对当前问题的临时操作，如重新搜索、全文加载某文件、用不同关键词再查一次、直接回复用户特定内容。这些操作只影响这一次，不改变系统。你有完整决策权。\n第二，系统级建议：如果你发现需要永久性修改（创建文件、修改tag、改压缩规则、改配置），只能提建议，由人类管理员决定。你没有执行权。\n输出 JSON：\n{ "one_time_action": "本次执行的临时操作描述，或 none", "system_suggestion": "给人类管理员的系统改进建议，或 none" }',
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
    return { one_time_action: 'none', system_suggestion: text };
  }
}

module.exports = { recall, extract, compress, diagnose, propose, judge };
