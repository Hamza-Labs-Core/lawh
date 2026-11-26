import { defineConfig } from '@playwright/test';

// App and content are two hosts, as in a real copy: cookies of one never reach the other.
export default defineConfig({
  testDir: 'e2e',
  retries: 0,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  timeout: 30_000,
  reporter: [['list']],
  projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({ name: browserName, ...(browserName !== 'chromium' && { testIgnore: 'passkey.spec.ts' }), use: { browserName,
    // Playwright WebKit skips page.route() once a service worker controls the page; e2e/pwa.spec.ts opts back in.
    serviceWorkers: 'block',
    // Chromium's own rule against reaching the local network would hide what the sandbox does or doesn't block.
    ...(browserName === 'chromium' && { launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } }) } })),
  webServer: { command: 'node e2e/serve.mjs', url: 'http://127.0.0.1:8799/ready', timeout: 120_000, reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
});
