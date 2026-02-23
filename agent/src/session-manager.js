const fs = require('fs');
const path = require('path');
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

    // Auto-execute safe operations
    let actionResult = '';
    if (verdict.decision === 'approve') {
      const action = verdict.action || '';
      // Safe: create new empty md file
      const newFileMatch = action.match(/新建.*?(\S+\.md)/);
      if (newFileMatch) {
        const newFile = newFileMatch[1];
        const libDir = path.resolve(__dirname, '../library');
        const filePath = path.join(libDir, newFile);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, `---\ntags: 待补充\nsummary: 待补充\n---\n待补充内容\n`);
          actionResult = `已自动创建 library/${newFile}`;
        } else {
          actionResult = `library/${newFile} 已存在，跳过创建`;
        }
      }
      // Safe: add tags to existing file
      const addTagMatch = action.match(/新增.*?tag.*?[：:](.+)/);
      if (addTagMatch && !actionResult) {
        actionResult = `建议新增 tag: ${addTagMatch[1].trim()}（需手动编辑文件）`;
      }
      if (!actionResult) {
        actionResult = `批准操作: ${action}`;
      }
    } else if (verdict.decision === 'human_review') {
      actionResult = '⏳ 等待人类审批';
    } else {
      actionResult = `已拒绝: ${verdict.reason || '不安全的操作'}`;
    }

    return {
      diagnosis: diagnosisText,
      proposal: proposalText,
      verdict,
      actionResult,
    };
  }

  return { handleMessage, handleRecall, handleEvolve, external };
}

module.exports = { createSessionManager };
