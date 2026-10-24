import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
// The local runner can supply a Chromium executable; CI uses Playwright's browser.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {baseURL: 'http://127.0.0.1:4173', viewport: {width: 1440, height: 1100}, headless: true,
    launchOptions: process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH) ? {executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu']} : {}},
  webServer: {command: 'npm run dev', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI},
});
