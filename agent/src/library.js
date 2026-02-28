const fs = require('fs');
const path = require('path');

const LIBRARY_DIR = path.resolve(__dirname, '../library');
const CACHE_TTL = 60 * 1000; // 60 seconds

let libraryCache = null;
let libraryCacheTime = 0;

function invalidateCache() {
  libraryCache = null;
}

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

function scanDir(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...scanDir(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md')) {
      results.push({ file: rel, fullPath: path.join(dir, entry.name) });
    }
  }
  return results;
}

function loadLibrary() {
  if (libraryCache && Date.now() - libraryCacheTime < CACHE_TTL) {
    return libraryCache;
  }
  const files = scanDir(LIBRARY_DIR, '');
  const result = files.map(({ file, fullPath }) => {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const parsed = parseFile(raw);
    if (!parsed) return null;
    return { file, ...parsed };
  }).filter(Boolean);
  libraryCache = result;
  libraryCacheTime = Date.now();
  return result;
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
  // Try direct path first, then scan
  let filePath = path.join(LIBRARY_DIR, filename);
  if (!fs.existsSync(filePath)) {
    // Search recursively
    const all = scanDir(LIBRARY_DIR, '');
    const found = all.find((f) => f.file === filename || f.file.endsWith('/' + filename));
    if (!found) return null;
    filePath = found.fullPath;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFile(raw);
  if (!parsed) return null;
  return { filename, content: parsed.content };
}

function getRawFileContent(filename) {
  let filePath = path.join(LIBRARY_DIR, filename);
  if (!fs.existsSync(filePath)) {
    const all = scanDir(LIBRARY_DIR, '');
    const found = all.find((f) => f.file === filename || f.file.endsWith('/' + filename));
    if (!found) return null;
    filePath = found.fullPath;
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFile(raw);
  if (!parsed) return null;
  return { filename, content: parsed.content, fullContent: raw };
}

module.exports = { loadLibrary, search, getAllSummaries, getFileContent, getRawFileContent, invalidateCache };
