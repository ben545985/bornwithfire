const library = require('./library');
const internal = require('./sessions/internal');
const { createExternal } = require('./sessions/external');

// DeepSeek: ¥1/M input, ¥2/M output
// Sonnet: $3/M input, $15/M output ≈ ¥21.6/M, ¥108/M (at 7.2 CNY/USD)
const COST = {
  deepseek: { input: 1 / 1e6, output: 2 / 1e6 },
  sonnet: { input: 21.6 / 1e6, output: 108 / 1e6 },
};

const MAX_EXTRACT_FILES = 5;
const EXTRACT_CHAR_LIMIT = 150;

const DISSATISFACTION_KEYWORDS = [
  '不记得', '忘了', '说过了', '上次说的', '不对', '不是这个',
  '找不到', '怎么又', '已经告诉你',
];

function calcCost(provider, inTokens, outTokens) {
  const rate = COST[provider];
  return rate.input * inTokens + rate.output * outTokens;
}

function createSessionManager() {
  const external = createExternal();
  let lastDebugLines = [];

  async function resolveContext(message, skipKeyword) {
    const debug = [];
    let dsInTotal = 0;
    let dsOutTotal = 0;

    // Step 1: keyword match
    let hitFiles = [];
    if (!skipKeyword) {
      const keywordResults = library.search(message);
      if (keywordResults.length > 0) {
        const entries = library.loadLibrary();
        const tokens = message.split(/[\s,，。！？、；：""''（）()《》\[\]【】\n]+/).filter(Boolean);
        const hitNames = entries
          .filter((e) => e.tags.some((tag) => tokens.some((t) => tag.includes(t) || t.includes(tag))))
          .map((e) => e.file);
        console.log(`[manager] keyword hit: ${hitNames.join(', ')}`);
        debug.push(`🔍 关键词: 命中 [${hitNames.join(', ')}]`);
        hitFiles = entries
          .filter((e) => hitNames.includes(e.file))
          .map((e) => ({ filename: e.file, content: e.content }));
      } else {
        debug.push('🔍 关键词: 未命中');
      }
    } else {
      debug.push('🔍 关键词: 跳过（/recall）');
    }

    // Step 2: no keyword hit → call recall
    if (hitFiles.length === 0) {
      console.log('[manager] keyword miss, calling recall...');
      const summaries = library.getAllSummaries();
      if (summaries.length > 0) {
        try {
          const { filenames, usage } = await internal.recall(message, summaries);
          dsInTotal += usage.input_tokens;
          dsOutTotal += usage.output_tokens;
          hitFiles = filenames
            .map((f) => library.getFileContent(f))
            .filter(Boolean);
          const names = filenames.length > 0 ? filenames.join(', ') : '无';
          debug.push(`🧠 回忆员: DeepSeek 返回 [${names}]`);
        } catch (err) {
          console.error('[manager] recall error:', err.message);
          debug.push(`🧠 回忆员: 出错 - ${err.message}`);
        }
      } else {
        debug.push('🧠 回忆员: 跳过（图书馆为空）');
      }
    } else {
      debug.push('🧠 回忆员: 跳过');
    }

    // Step 3: extract per file (max 5 files, 150 chars each)
    let context = '';
    if (hitFiles.length > 0) {
      const filesToProcess = hitFiles.slice(0, MAX_EXTRACT_FILES);
      const extractResults = [];
      const extractDebugParts = [];

      for (const file of filesToProcess) {
        try {
          const result = await internal.extract(message, file.content, EXTRACT_CHAR_LIMIT);
          dsInTotal += result.usage.input_tokens;
          dsOutTotal += result.usage.output_tokens;
          if (result.text !== '无相关内容') {
            extractResults.push(result.text);
            extractDebugParts.push(`${file.filename}(${result.inputLen}字→${result.outputLen}字)`);
          }
        } catch (err) {
          console.error(`[manager] extract error for ${file.filename}:`, err.message);
        }
      }

      if (extractResults.length > 0) {
        context = extractResults.join('\n\n');
        debug.push(`📦 提取员: ${extractDebugParts.join(' + ')}`);
      } else {
        debug.push('📦 提取员: 无相关内容');
      }
    } else {
      debug.push('📦 提取员: 跳过');
    }

    return { context, debug, dsInTotal, dsOutTotal };
  }

  function detectDissatisfaction(message) {
    return DISSATISFACTION_KEYWORDS.some((kw) => message.includes(kw));
  }

  async function handleMessage(userId, message, imageUrls) {
    const { context, debug, dsInTotal, dsOutTotal } = await resolveContext(message);
    const result = await external.reply(userId, message, context, imageUrls);

    debug.push(`💬 外部session: context ${result.contextLen}字, in=${result.input_tokens} out=${result.output_tokens}`);

    const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
    const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
    debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);

    lastDebugLines = debug;
    const dissatisfied = detectDissatisfaction(message);

    return { reply: result.text, debug, dissatisfied };
  }

  async function handleRecall(userId, query) {
    const { context, debug, dsInTotal, dsOutTotal } = await resolveContext(query, true);
    const result = await external.reply(userId, query, context);

    debug.push(`💬 外部session: context ${result.contextLen}字, in=${result.input_tokens} out=${result.output_tokens}`);

    const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
    const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
    debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);

    lastDebugLines = debug;

    return { reply: result.text, debug };
  }

  async function handleEvolve(userId) {
    const chatHistory = external.getHistory(userId);
    const debugLog = lastDebugLines.join('\n');

    // Find the complaint (last user message)
    const lastUserMsg = [...chatHistory].reverse().find((m) => m.role === 'user');
    const complaint = lastUserMsg ? lastUserMsg.content : '用户不满意';

    const diagnosisText = await internal.diagnose(complaint, chatHistory, debugLog);
    const proposalText = await internal.propose(diagnosisText);
    const verdict = await internal.judge(diagnosisText, proposalText);

    const oneTimeAction = verdict.one_time_action || 'none';
    const systemSuggestion = verdict.system_suggestion || 'none';

    // Execute one-time action if applicable
    let oneTimeResult = '';
    if (oneTimeAction !== 'none') {
      // Try to execute: fullload a file, re-search, etc.
      const fileMatch = oneTimeAction.match(/(?:加载|fullload|读取).*?(\S+\.md)/i);
      if (fileMatch) {
        const file = library.getFileContent(fileMatch[1]);
        if (file) {
          external.setFullloadContext(userId, file.content);
          oneTimeResult = `已加载 ${fileMatch[1]}（${file.content.length}字）到下次回复`;
        } else {
          oneTimeResult = `文件 ${fileMatch[1]} 不存在`;
        }
      }
      // Try re-search with different keywords
      const searchMatch = oneTimeAction.match(/(?:搜索|查找|检索).*?[：:"""](.+?)["""]?$/);
      if (searchMatch && !oneTimeResult) {
        const query = searchMatch[1].trim();
        const { context } = await resolveContext(query, true);
        if (context) {
          external.setFullloadContext(userId, context);
          oneTimeResult = `已用"${query}"重新检索并注入结果`;
        } else {
          oneTimeResult = `用"${query}"重新检索未找到相关内容`;
        }
      }
      if (!oneTimeResult) {
        oneTimeResult = `一次性操作: ${oneTimeAction}`;
      }
    }

    return {
      diagnosis: diagnosisText,
      proposal: proposalText,
      verdict,
      oneTimeAction,
      oneTimeResult,
      systemSuggestion,
    };
  }

  return { handleMessage, handleRecall, handleEvolve, external };
}

module.exports = { createSessionManager };
