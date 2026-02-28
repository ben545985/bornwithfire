const Anthropic = require('@anthropic-ai/sdk');

function createOAuthClient() {
  return new Anthropic({
    apiKey: null,
    authToken: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/1.0.0 (external, cli)',
      'x-app': 'cli',
    },
  });
}

module.exports = { createOAuthClient };
