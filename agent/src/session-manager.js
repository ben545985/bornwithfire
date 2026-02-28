const fs = require('fs');
const path = require('path');
const library = require('./library');
const internal = require('./sessions/internal');
const { createExternal } = require('./sessions/external');
const { createOAuthClient } = require('./anthropic-client');
const braveSearch = require('./brave-search');

const TRANSCRIPT_DIR = path.resolve(__dirname, '../data/transcripts');
if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

function appendTranscript(userId, role, content) {
  const line = JSON.stringify({ ts: new Date().toISOString(), userId, role, content }) + '\n';
  const file = path.join(TRANSCRIPT_DIR, `${userId}.jsonl`);
  fs.appendFileSync(file, line);
}

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
  const external = createExternal(createOAuthClient());
  let lastDebugLines = [];
  const pendingAction = new Map(); // userId → { action: 'reset'|'compress', ts: number }

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
      debug.push('🔍 关键词: 跳过（recall）');
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

  async function handleMessage(userId, message, imageUrls, { startTime, sendEvolution } = {}) {
    // Persist user message to transcript
    if (message) appendTranscript(userId, 'user', message);
    if (imageUrls && imageUrls.length > 0) appendTranscript(userId, 'user', `[${imageUrls.length}张图片]`);

    // Detect intent (single DeepSeek call)
    let intent = { needSearch: false, query: '', control: 'none', args: '', usage: { input_tokens: 0, output_tokens: 0 } };
    if (message) {
      try {
        intent = await internal.detectIntent(message);
      } catch (err) {
        console.error('[manager] intent detection error:', err.message);
      }
    }

    const control = intent.control || 'none';
    const args = intent.args || '';
    const debug = [];
    let dsInTotal = intent.usage.input_tokens;
    let dsOutTotal = intent.usage.output_tokens;

    if (control !== 'none') debug.push(`🎛️ 意图: ${control}${args ? ' → ' + args : ''}`);

    // === Handle confirm: execute pending action ===
    if (control === 'confirm') {
      const pending = pendingAction.get(userId);
      if (pending && Date.now() - pending.ts < 5 * 60 * 1000) {
        pendingAction.delete(userId);
        if (pending.action === 'reset') {
          external.clearHistory(userId);
          debug.push('🔄 确认执行: reset');
          const contextParts = ['【系统提示】用户确认了清空对话。对话历史已清空。请告知用户对话已重新开始，可以开始新的话题。'];
          const result = await external.reply(userId, message, contextParts.join('\n\n'), imageUrls);
          appendTranscript(userId, 'assistant', result.text);
          debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
          lastDebugLines = debug;
          return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
        } else if (pending.action === 'compress') {
          try {
            const { count, summary, facts } = await external.compress(userId);
            if (count === 0) {
              debug.push('📎 确认执行: compress — 无历史');
              const result = await external.reply(userId, message, '【系统提示】用户确认了压缩对话，但当前没有对话历史可压缩。请告知用户。', imageUrls);
              appendTranscript(userId, 'assistant', result.text);
              lastDebugLines = debug;
              return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
            }
            const factsInfo = facts && facts.length > 0 ? `，提取了 ${facts.length} 条关键事实` : '';
            debug.push(`📎 确认执行: compress — ${count} 条消息`);
            const contextParts = [`【系统提示】用户确认了压缩对话。已将 ${count} 条消息压缩为摘要${factsInfo}。请告知用户压缩完成。`];
            const result = await external.reply(userId, message, contextParts.join('\n\n'), imageUrls);
            appendTranscript(userId, 'assistant', result.text);
            lastDebugLines = debug;
            return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
          } catch (err) {
            console.error('[compress error]', err.message);
            debug.push(`📎 压缩失败: ${err.message}`);
            const result = await external.reply(userId, message, '【系统提示】压缩对话时出错，请告知用户稍后再试。', imageUrls);
            appendTranscript(userId, 'assistant', result.text);
            lastDebugLines = debug;
            return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
          }
        }
      }
      // No pending action or expired — treat as normal message
      debug.push('⚠️ 无待确认操作，按普通消息处理');
    }

    // === Handle reset/compress: set pending, ask Claude to confirm ===
    if (control === 'reset') {
      pendingAction.set(userId, { action: 'reset', ts: Date.now() });
      debug.push('🔄 待确认: reset');
      const contextParts = ['【系统提示】用户想清空对话重新开始。请用你自己的语气向用户确认：告诉他们这会清空当前所有对话记忆，问他们确定要这样做吗。等待用户确认后再执行。'];
      const result = await external.reply(userId, message, contextParts.join('\n\n'), imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
    }

    if (control === 'compress') {
      pendingAction.set(userId, { action: 'compress', ts: Date.now() });
      debug.push('📎 待确认: compress');
      const msgCount = external.historyCount(userId);
      const contextParts = [`【系统提示】用户想压缩当前对话。当前有 ${msgCount} 条消息。请用你自己的语气向用户确认：告诉他们压缩会将对话历史精简为摘要，问他们确定要这样做吗。等待用户确认后再执行。`];
      const result = await external.reply(userId, message, contextParts.join('\n\n'), imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
    }

    // === Handle status: collect info, inject as context ===
    if (control === 'status') {
      const msgCount = external.historyCount(userId);
      const libCount = library.loadLibrary().length;
      let uptimeInfo = '';
      if (startTime) {
        const uptimeMs = Date.now() - startTime;
        const hours = Math.floor(uptimeMs / 3600000);
        const minutes = Math.floor((uptimeMs % 3600000) / 60000);
        uptimeInfo = `\nBot 运行时间：${hours}小时${minutes}分钟`;
      }
      const statusData = `当前对话：${msgCount} 条消息\n图书馆文件：${libCount} 个\n对话模型：claude-sonnet-4-6\n内部模型：deepseek-chat${uptimeInfo}`;
      debug.push(`📊 状态查询`);
      const contextParts = [`【系统提示】用户在询问你的状态。以下是当前状态数据，请用你自己的语气回复：\n${statusData}`];
      const { context: libCtx, debug: ctxDebug, dsInTotal: ctxDsIn, dsOutTotal: ctxDsOut } = await resolveContext(message);
      dsInTotal += ctxDsIn;
      dsOutTotal += ctxDsOut;
      debug.push(...ctxDebug);
      if (libCtx) contextParts.push('【图书馆资料】\n' + libCtx);
      const result = await external.reply(userId, message, contextParts.join('\n\n'), imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
      const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
      debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
    }

    // === Handle search: Brave search → inject context ===
    if (control === 'search') {
      const query = args || message;
      debug.push('🔍 关键词: 跳过（search意图）');
      debug.push('🧠 回忆员: 跳过');
      debug.push('📦 提取员: 跳过');
      let searchResults = '';
      try {
        searchResults = await braveSearch.search(query);
        debug.push(`🌐 Brave搜索: "${query}"`);
        console.log(`[manager] search intent for "${query}", got ${searchResults.length} chars`);
      } catch (err) {
        console.error('[manager] Brave search error:', err.message);
        debug.push(`🌐 Brave搜索: 出错 - ${err.message}`);
      }
      const searchContext = searchResults ? `以下是关于"${query}"的网络搜索结果：\n\n${searchResults}` : '';
      const result = await external.reply(userId, message, searchContext ? '【网络搜索结果】\n' + searchContext : '', imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
      const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
      debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, searchContext, userId), cumulative: result.cumulative };
    }

    // === Handle recall: library recall → inject context ===
    if (control === 'recall') {
      const query = args || message;
      const { context, debug: ctxDebug, dsInTotal: ctxDsIn, dsOutTotal: ctxDsOut } = await resolveContext(query, true);
      dsInTotal += ctxDsIn;
      dsOutTotal += ctxDsOut;
      debug.push(...ctxDebug);
      const result = await external.reply(userId, message, context ? '【图书馆资料】\n' + context : '', imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
      const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
      debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, context, userId), cumulative: result.cumulative };
    }

    // === Handle fullload: load file into context ===
    if (control === 'fullload') {
      const filename = args || '';
      if (!filename) {
        const result = await external.reply(userId, message, '【系统提示】用户想加载文件但没有指定文件名。请告知用户需要指定文件名，可以先用"图书馆有什么"查看可用文件。', imageUrls);
        appendTranscript(userId, 'assistant', result.text);
        debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
        lastDebugLines = debug;
        return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
      }
      const file = library.getRawFileContent(filename);
      if (!file) {
        const result = await external.reply(userId, message, `【系统提示】用户想加载文件"${filename}"，但该文件不存在。请告知用户，并建议用"图书馆有什么"查看可用文件。`, imageUrls);
        appendTranscript(userId, 'assistant', result.text);
        debug.push(`📥 fullload: 文件不存在 ${filename}`);
        lastDebugLines = debug;
        return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
      }
      external.setFullloadContext(userId, file.content);
      debug.push(`📥 fullload: ${filename} (${file.content.length}字)`);
      const result = await external.reply(userId, message, `【系统提示】已将文件"${filename}"（${file.content.length} 字）加载到当前对话上下文。请告知用户文件已加载。`, imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
    }

    // === Handle library: list files ===
    if (control === 'library') {
      const summaries = library.getAllSummaries();
      const fileList = summaries.length === 0
        ? '图书馆为空。'
        : summaries.map((s) => `• ${s.filename} — ${s.summary || '无描述'}`).join('\n');
      debug.push(`📚 图书馆列表`);
      const result = await external.reply(userId, message, `【系统提示】用户想查看图书馆文件列表。以下是当前图书馆的所有文件，请用你自己的语气呈现：\n${fileList}`, imageUrls);
      appendTranscript(userId, 'assistant', result.text);
      debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
      lastDebugLines = debug;
      return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
    }

    // === Handle evolve: three-sage self-check ===
    if (control === 'evolve') {
      debug.push('🔧 自检流程启动');
      try {
        const chatHistory = external.getHistory(userId);
        const debugLog = lastDebugLines.join('\n');
        const lastUserMsg = [...chatHistory].reverse().find((m) => m.role === 'user');
        const complaint = lastUserMsg ? lastUserMsg.content : '用户不满意';

        const diagnosisText = await internal.diagnose(complaint, chatHistory, debugLog);
        const proposalText = await internal.propose(diagnosisText);
        const verdict = await internal.judge(diagnosisText, proposalText);

        const oneTimeAction = verdict.one_time_action || 'none';
        const systemSuggestion = verdict.system_suggestion || 'none';

        // Execute one-time action
        let oneTimeResult = '';
        if (oneTimeAction !== 'none') {
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
          if (!oneTimeResult) oneTimeResult = `一次性操作: ${oneTimeAction}`;
        }

        // Build evolve context for Claude to respond naturally
        let evolveInfo = `诊断：${diagnosisText}\n建议：${proposalText}`;
        if (oneTimeAction !== 'none') evolveInfo += `\n已执行：${oneTimeResult}`;
        if (systemSuggestion !== 'none') evolveInfo += `\n系统改进建议已提交到进化频道，等待管理员审批。`;

        // Send to evolution channel
        if (sendEvolution) {
          const evoLines = [
            '⚠️ 用户不满事件',
            `🔍 诊断员：${diagnosisText}`,
            `💡 方案员：${proposalText}`,
          ];
          if (oneTimeAction !== 'none') evoLines.push(`⚡ 一次性操作：${oneTimeResult}`);
          if (systemSuggestion !== 'none') evoLines.push(`📋 系统改进建议（需人类审批）：\n${systemSuggestion}`);
          sendEvolution(evoLines);
        }

        debug.push(`🔍 诊断: ${diagnosisText.slice(0, 60)}...`);
        const result = await external.reply(userId, message, `【系统提示】自检完成。以下是自检结果，请用你自己的语气告知用户：\n${evolveInfo}`, imageUrls);
        appendTranscript(userId, 'assistant', result.text);
        debug.push(`💬 外部session: in=${result.input_tokens} out=${result.output_tokens}`);
        lastDebugLines = debug;
        return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
      } catch (err) {
        console.error('[evolve error]', err.message);
        debug.push(`🔧 自检失败: ${err.message}`);
        const result = await external.reply(userId, message, '【系统提示】自检过程出错，请告知用户稍后再试。', imageUrls);
        appendTranscript(userId, 'assistant', result.text);
        lastDebugLines = debug;
        return { reply: result.text, debug, dissatisfied: false, statusBar: buildStatusBar(result, '', userId), cumulative: result.cumulative };
      }
    }

    // === Normal message flow ===
    const { context, debug: ctxDebug, dsInTotal: ctxDsIn, dsOutTotal: ctxDsOut } = await resolveContext(message);
    dsInTotal += ctxDsIn;
    dsOutTotal += ctxDsOut;
    debug.push(...ctxDebug);

    // Auto search if intent says so
    let searchContext = '';
    if (intent.needSearch && intent.query) {
      try {
        const searchResults = await braveSearch.search(intent.query);
        searchContext = `以下是关于"${intent.query}"的网络搜索结果：\n\n${searchResults}`;
        debug.push(`🌐 搜索: "${intent.query}"`);
        console.log(`[manager] auto search for "${intent.query}", got ${searchResults.length} chars`);
      } catch (err) {
        console.error('[manager] search error:', err.message);
        debug.push(`🌐 搜索: 出错 - ${err.message}`);
      }
    } else {
      debug.push('🌐 搜索: 未触发');
    }

    // Build context parts
    const contextParts = [];
    if (context) contextParts.push('【图书馆资料】\n' + context);
    if (searchContext) contextParts.push('【网络搜索结果】\n' + searchContext);
    const mergedContext = contextParts.join('\n\n');
    const result = await external.reply(userId, message, mergedContext, imageUrls);

    // Persist assistant reply to transcript
    appendTranscript(userId, 'assistant', result.text);

    debug.push(`💬 外部session: context ${result.contextLen || 0}字, in=${result.input_tokens} out=${result.output_tokens}`);

    const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
    const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
    debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);

    lastDebugLines = debug;
    const dissatisfied = detectDissatisfaction(message);

    return { reply: result.text, debug, dissatisfied, statusBar: buildStatusBar(result, searchContext, userId), cumulative: result.cumulative };
  }

  function buildStatusBar(result, searchContext, userId) {
    const bd = result.breakdown;
    if (!bd) return '';
    const CTX_LIMIT = 200000;
    const pct = ((bd.inputTokens / CTX_LIMIT) * 100).toFixed(1);
    return `📊 人设 ${bd.soul} | 历史 ${bd.historyCount}条 ${bd.history} | 资料 ${bd.context} | 搜索 ${searchContext ? searchContext.length : 0} | input ${bd.inputTokens.toLocaleString()}tk / ${CTX_LIMIT / 1000}k (${pct}%) | output ${bd.outputTokens.toLocaleString()}tk`;
  }

  return { handleMessage, external };
}

module.exports = { createSessionManager };
