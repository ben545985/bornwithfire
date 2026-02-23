const library = require('./library');
const internal = require('./sessions/internal');
const { createExternal } = require('./sessions/external');

// DeepSeek: ¥1/M input, ¥2/M output
// Sonnet: $3/M input, $15/M output ≈ ¥21.6/M, ¥108/M (at 7.2 CNY/USD)
const COST = {
  deepseek: { input: 1 / 1e6, output: 2 / 1e6 },
  sonnet: { input: 21.6 / 1e6, output: 108 / 1e6 },
};

function calcCost(provider, inTokens, outTokens) {
  const rate = COST[provider];
  return rate.input * inTokens + rate.output * outTokens;
}

function createSessionManager() {
  const external = createExternal();

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

    // Step 3: extract if we have files
    let context = '';
    if (hitFiles.length > 0) {
      try {
        const rawContent = hitFiles.map((f) => f.content).join('\n---\n');
        const result = await internal.extract(message, rawContent);
        dsInTotal += result.usage.input_tokens;
        dsOutTotal += result.usage.output_tokens;
        if (result.text !== '无相关内容') {
          context = result.text;
          debug.push(`📦 提取员: ${result.inputLen}字 → ${result.outputLen}字`);
        } else {
          debug.push('📦 提取员: 无相关内容');
        }
      } catch (err) {
        console.error('[manager] extract error:', err.message);
        debug.push(`📦 提取员: 出错 - ${err.message}`);
      }
    } else {
      debug.push('📦 提取员: 跳过');
    }

    return { context, debug, dsInTotal, dsOutTotal };
  }

  async function handleMessage(userId, message, imageUrls) {
    const { context, debug, dsInTotal, dsOutTotal } = await resolveContext(message);
    const result = await external.reply(userId, message, context, imageUrls);

    debug.push(`💬 外部session: context ${result.contextLen}字, in=${result.input_tokens} out=${result.output_tokens}`);

    const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
    const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
    debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);

    return { reply: result.text, debug };
  }

  async function handleRecall(userId, query) {
    const { context, debug, dsInTotal, dsOutTotal } = await resolveContext(query, true);
    const result = await external.reply(userId, query, context);

    debug.push(`💬 外部session: context ${result.contextLen}字, in=${result.input_tokens} out=${result.output_tokens}`);

    const dsCost = calcCost('deepseek', dsInTotal, dsOutTotal);
    const sonnetCost = calcCost('sonnet', result.input_tokens, result.output_tokens);
    debug.push(`💰 本次成本: DeepSeek ¥${dsCost.toFixed(4)} + Sonnet ¥${sonnetCost.toFixed(4)}`);

    return { reply: result.text, debug };
  }

  return { handleMessage, handleRecall, external };
}

module.exports = { createSessionManager };
