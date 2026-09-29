import { defineConfig, devices } from '@playwright/test';

/* Port 8090, never 8080: browser storage is per-origin, and 8080 is where the
   real board's price history, consensus archive and assessment log live. The
   tests run in a throwaway profile anyway, but a stray manual visit to the test
   server must not look like the real board either. */
const PORT = 8090;
export const PROXY_PORT = 8091;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 300_000,   // the mocked board load runs at the app's real rate limit
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],   // first, so the viewport below wins
    baseURL: `http://localhost:${PORT}/bolt/`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `node static-server.mjs ${PORT}`,
      url: `http://localhost:${PORT}/bolt/`,
      reuseExistingServer: false,
    },
    /* The real serve.mjs, for the proxy-mode check — with every key blanked,
       so nothing it proxies can spend anything. */
    {
      command: `node ../serve.mjs ${PROXY_PORT}`,
      url: `http://localhost:${PROXY_PORT}/bolt/ping`,
      reuseExistingServer: false,
      env: { FINNHUB_API_KEY: '', BOLT_ANTHROPIC_KEY: '', ANTHROPIC_API_KEY: '' },
    },
  ],
});
