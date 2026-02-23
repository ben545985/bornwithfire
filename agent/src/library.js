const fs = require('fs');
const path = require('path');

const LIBRARY_DIR = path.resolve(__dirname, '../library');

function parseFile(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const header = match[1];
  const content = match[2].trim();

  const tagsMatch = header.match(/tags:\s*(.+)/);
  const summaryMatch = header.match(/summary:\s*(.+)/);

  const tags = tagsMatch
    ? tagsMatch[1].split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    : [];
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  return { tags, summary, content };
}

function loadLibrary() {
  if (!fs.existsSync(LIBRARY_DIR)) return [];

  const files = fs.readdirSync(LIBRARY_DIR).filter((f) => f.endsWith('.md'));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(LIBRARY_DIR, file), 'utf-8');
    const parsed = parseFile(raw);
    if (!parsed) return null;
    return { file, ...parsed };
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

function getAllSummaries() {
  return loadLibrary().map((entry) => ({
    filename: entry.file,
    tags: entry.tags,
    summary: entry.summary,
  }));
}

function getFileContent(filename) {
  const filePath = path.join(LIBRARY_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFile(raw);
  if (!parsed) return null;
  return { filename, content: parsed.content };
}

module.exports = { loadLibrary, search, getAllSummaries, getFileContent };
