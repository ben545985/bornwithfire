const library = require('./library');
const internal = require('./sessions/internal');
const { createExternal } = require('./sessions/external');

function createSessionManager() {
  const external = createExternal();

  async function resolveContext(message, skipKeyword) {
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
        hitFiles = entries
          .filter((e) => hitNames.includes(e.file))
          .map((e) => ({ filename: e.file, content: e.content }));
      }
    }

    // Step 2: no keyword hit → call recall
    if (hitFiles.length === 0) {
      console.log('[manager] keyword miss, calling recall...');
      const summaries = library.getAllSummaries();
      if (summaries.length > 0) {
        try {
          const filenames = await internal.recall(message, summaries);
          hitFiles = filenames
            .map((f) => library.getFileContent(f))
            .filter(Boolean);
        } catch (err) {
          console.error('[manager] recall error:', err.message);
        }
      }
    }

    // Step 3: extract if we have files
    if (hitFiles.length > 0) {
      try {
        const rawContent = hitFiles.map((f) => f.content).join('\n---\n');
        const extracted = await internal.extract(message, rawContent);
        if (extracted !== '无相关内容') return extracted;
      } catch (err) {
        console.error('[manager] extract error:', err.message);
      }
    }

    return '';
  }

  async function handleMessage(userId, message, imageUrls) {
    const context = await resolveContext(message);
    return external.reply(userId, message, context, imageUrls);
  }

  async function handleRecall(userId, query) {
    const context = await resolveContext(query, true);
    return external.reply(userId, query, context);
  }

  return { handleMessage, handleRecall, external };
}

module.exports = { createSessionManager };
