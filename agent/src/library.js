const fs = require('fs');
const path = require('path');

const LIBRARY_DIR = path.resolve(__dirname, '../library');

function loadLibrary() {
  if (!fs.existsSync(LIBRARY_DIR)) return [];

  const files = fs.readdirSync(LIBRARY_DIR).filter((f) => f.endsWith('.md'));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(LIBRARY_DIR, file), 'utf-8');
    const match = raw.match(/^---\s*\ntags:\s*(.+)\n---\s*\n([\s\S]*)$/);
    if (!match) return null;
    const tags = match[1].split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    const content = match[2].trim();
    return { file, tags, content };
  }).filter(Boolean);
}

function tokenize(text) {
  return text.split(/[\s,，。！？、；：""''（）()《》\[\]【】\n]+/).filter(Boolean);
}

function search(message) {
  const entries = loadLibrary();
  const tokens = tokenize(message);
  const results = [];

  for (const entry of entries) {
    const hit = entry.tags.some((tag) =>
      tokens.some((token) => tag.includes(token) || token.includes(tag))
    );
    if (hit) results.push(entry.content);
  }

  return results;
}

module.exports = { loadLibrary, search };
