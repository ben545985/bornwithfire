const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

async function search(query, count = 5) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY is not set');
  }

  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const results = (data.web && data.web.results) || [];

  if (results.length === 0) {
    return '没有找到相关搜索结果。';
  }

  return results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.description}\n${r.url}`)
    .join('\n\n');
}

module.exports = { search };
