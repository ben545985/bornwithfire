const OpenAI = require('openai');

// Extracts the first complete JSON object from text using brace counting,
// avoiding the greedy regex pitfall of matching outermost braces incorrectly.
function extractFirstObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractFirstArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

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
    const match = extractFirstArray(text);
    filenames = match ? JSON.parse(match) : [];
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
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : '[图片消息]';
      return `${m.role === 'user' ? '用户' : '助手'}：${content}`;
    })
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
    const jsonMatch = extractFirstObject(text);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch);
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
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : '[图片消息]';
      return `${m.role === 'user' ? '用户' : '助手'}：${content}`;
    })
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
    const match = extractFirstObject(text);
    if (match) {
      try { return JSON.parse(match); } catch { /* fall through */ }
    }
    return { one_time_action: 'none', system_suggestion: text };
  }
}

async function detectIntent(userMessage) {
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `分析用户消息的意图。判断两件事：

1. 是否需要联网搜索？搜索门槛要低——只要消息涉及任何事实、人物、地点、事件、价格、新闻、天气、产品、公司、法律、科技、文化等话题，都应该搜索。只有纯粹的闲聊、情感表达、创意写作、或明确针对私人记忆的问题才不需要搜索。

2. 用户的控制意图是什么？用户可能用自然语言或斜杠命令表达以下意图：
   - "reset"：清空对话（如"重新开始"、"清空记忆"、"忘掉之前说的"、"新话题"、"/reset"）
   - "compress"：压缩对话（如"压缩一下"、"总结一下对话"、"帮我精简上下文"、"/compress"）
   - "status"：查看状态（如"你什么状态"、"现在情况怎样"、"/ping"、"/status"）
   - "search"：主动搜索（如"搜一下XX"、"帮我查查XX"、"/search XX"）— args 填搜索词
   - "recall"：回忆图书馆（如"你还记得XX吗"、"回忆一下XX"、"/recall XX"）— args 填查询词
   - "fullload"：加载文件（如"加载XX文件"、"把XX载入上下文"、"/fullload XX"）— args 填文件名
   - "library"：查看图书馆（如"图书馆有什么"、"列出所有文件"、"/library"）
   - "evolve"：自检改进（如"自检一下"、"分析一下问题"、"/evolve"）
   - "confirm"：用户确认执行待定操作（如"好的"、"确认"、"执行吧"、"是的"）— 仅当上文有待确认操作时才用
   - "none"：普通对话，不是控制指令

注意：
- 当 control 是 search/recall/fullload 时，必须从用户消息中提取 args（搜索词/查询词/文件名）
- 当 control 是 search 时，need_search 应为 false（搜索由系统单独处理）
- "confirm" 仅用于用户明确表示同意/确认的简短回复，不要把普通对话误判为 confirm

只输出 JSON：{"need_search": true/false, "query": "搜索词", "control": "none/reset/compress/status/search/recall/fullload/library/evolve/confirm", "args": "参数"}`,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  const usage = response.usage || {};
  console.log(`[internal:intent] DeepSeek returned: ${text}`);

  const defaults = {
    needSearch: false,
    query: '',
    control: 'none',
    args: '',
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };

  function parseIntent(parsed) {
    return {
      ...defaults,
      needSearch: !!parsed.need_search,
      query: parsed.query || '',
      control: parsed.control || 'none',
      args: parsed.args || '',
    };
  }

  try {
    return parseIntent(JSON.parse(text));
  } catch {
    const match = extractFirstObject(text);
    if (match) {
      try {
        return parseIntent(JSON.parse(match));
      } catch { /* fall through */ }
    }
    return defaults;
  }
}

module.exports = { recall, extract, compress, diagnose, propose, judge, detectIntent };
