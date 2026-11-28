import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';
import { writeCameraVideo } from './tools/lib/camera-fixture.ts';
import { e2ePorts } from './tools/lib/e2e-ports.ts';
import { e2eWebServer } from './tools/lib/e2e-web-server.ts';

const cameraVideo = resolve('.wrangler/camera-qr.y4m');
writeCameraVideo(cameraVideo);

// Playwright #42768: isolate Firefox app data from macOS 27's protected real-browser folder.
const firefoxData = resolve('.wrangler/firefox-camera');
if (process.platform === 'darwin') mkdirSync(firefoxData, { recursive: true });

export default defineConfig({
  ...base,
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'native-camera-chromium',
      testMatch: /18-scan-native-camera\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        browserName: 'chromium',
        baseURL: `https://localhost:${e2ePorts.camera}`,
        ignoreHTTPSErrors: true,
        permissions: ['camera'],
        viewport: { width: 390, height: 844 },
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${cameraVideo}`,
          ],
        },
      },
    },
    ...(['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
      name: `camera-${browserName}`,
      testMatch: /17-scan-camera\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        browserName,
        ...(browserName === 'firefox' && process.platform === 'darwin'
          ? { launchOptions: { env: { ...process.env, CFFIXED_USER_HOME: firefoxData } } }
          : {}),
        baseURL: `https://localhost:${e2ePorts.camera}`,
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
      },
    })),
  ],
  webServer: [
    e2eWebServer(),
    {
      command: 'node tools/e2e-camera-proxy.ts',
      url: `https://localhost:${e2ePorts.camera}/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
