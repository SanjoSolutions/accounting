const { chromium } = require('@playwright/test')

function lighthousePort(env = process.env) {
  const value = env.LIGHTHOUSE_PORT ?? '3234'
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    throw new Error('LIGHTHOUSE_PORT must be an unprivileged port other than the live app port 3000.')
  }
  return port
}

function createLighthouseConfig(env = process.env) {
  const origin = `http://127.0.0.1:${lighthousePort(env)}`
  return {
    ci: {
      collect: {
        url: [`${origin}/?year=2026`, `${origin}/bookings?year=2026`, `${origin}/settings`],
        numberOfRuns: 3,
        chromePath: chromium.executablePath(),
        settings: {
          preset: 'desktop',
          onlyCategories: ['performance', 'accessibility', 'best-practices'],
          // Keep language and simulated throttling consistent on local and CI runs.
          locale: 'en-US',
          extraHeaders: { 'Accept-Language': 'en-US' },
          throttlingMethod: 'simulate',
        },
      },
      assert: {
        assertions: {
          'categories:performance': ['error', { minScore: 0.8, aggregationMethod: 'median' }],
          'categories:accessibility': ['error', { minScore: 0.9, aggregationMethod: 'pessimistic' }],
          'categories:best-practices': ['error', { minScore: 0.95, aggregationMethod: 'pessimistic' }],
          'http-status-code': ['error', { minScore: 1, aggregationMethod: 'pessimistic' }],
          'errors-in-console': ['error', { minScore: 1, aggregationMethod: 'pessimistic' }],
        },
      },
      upload: {
        target: 'filesystem',
        outputDir: './lighthouse-reports',
      },
    },
  }
}

module.exports = { lighthousePort, createLighthouseConfig }
