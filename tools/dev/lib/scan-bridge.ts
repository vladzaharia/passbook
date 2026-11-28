// The native bridge states (W82): a fake app host answers `hello` with `ready` listing scanAck and
// scanSettle, feeds barcode reads, and records what the page sends back. Mirrors e2e/18-scan-native-camera.spec.ts.
import type { Page } from '@playwright/test';
import type { Run } from './scan-states.ts';

type Sent = { op: string; id?: string; outcome?: string; reason?: string };

/** Installs the fake host before the page loads. */
export async function installFakeApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const native = {
      sent: [] as Record<string, unknown>[],
      onmessage: null as ((e: { data: string }) => void) | null,
      postMessage(message: string) {
        const m = JSON.parse(message);
        this.sent.push(m);
        if (m.op === 'hello')
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({
                version: 2,
                event: 'ready',
                features: ['scanAck', 'scanSettle'],
                capabilities: {},
              }),
            });
          }, 0);
      },
    };
    Object.assign(window, { PassBookNative: native });
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Camera off', 'NotAllowedError'));
  });
}

const feed = (page: Page, id: string, value: string) =>
  page.evaluate(
    ([id, value]) =>
      (
        window as unknown as { PassBookNative: { onmessage: (e: { data: string }) => void } }
      ).PassBookNative.onmessage({
        data: JSON.stringify({ version: 2, event: 'scan', source: 'barcode', id, value }),
      }),
    [id, value] as [string, string],
  );

const sent = (page: Page): Promise<Sent[]> =>
  page.evaluate(
    () => (window as unknown as { PassBookNative: { sent: Sent[] } }).PassBookNative.sent,
  );

/** The app-side ops for the note on a shot, hello and acks left out. */
async function ops(page: Page): Promise<string> {
  return (await sent(page))
    .filter((m) => ['result', 'revise', 'dropped'].includes(m.op))
    .map((m) => `${m.op} ${m.id} ${m.outcome ?? m.reason ?? ''}`.trim())
    .join('; ');
}

async function waitOp(page: Page, op: string, id: string) {
  for (let i = 0; i < 60; i++) {
    if ((await sent(page)).some((m) => m.op === op && m.id === id)) return;
    await page.waitForTimeout(250);
  }
}

async function startScanning(page: Page) {
  await page.waitForTimeout(1_000);
  const start = page.getByRole('button', { name: 'Start scanning' });
  if (await start.isVisible().catch(() => false)) await start.click();
  await page.waitForTimeout(1_000);
}

/** Door: a read settles, then the same code again is dropped as a duplicate. */
export async function doorBridgeStates(r: Run, codes: string[]): Promise<void> {
  const { page } = r;
  await startScanning(page);
  await feed(page, 'first', codes[0] as string);
  await waitOp(page, 'result', 'first');
  await page.waitForTimeout(500);
  await r.snap('bridge-door-settled', await ops(page));
  await feed(page, 'dup', codes[0] as string);
  await waitOp(page, 'dropped', 'dup');
  await page.waitForTimeout(500);
  await r.snap('bridge-door-dropped-duplicate', await ops(page));
}

/** Desk: the member card is answered accepted while the check-in is held; its late band then revises it. */
export async function deskBridgeStates(r: Run, codes: string[]): Promise<void> {
  const { page } = r;
  await startScanning(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/scan/actions', async (route) => {
    await held;
    await route.continue();
  });
  // A fresh pass: the card opens at once, then the held check-in lands as its band.
  await feed(page, 'late', codes[1] as string);
  await waitOp(page, 'result', 'late');
  await page.waitForTimeout(600);
  await r.snap('bridge-desk-card-before-band', await ops(page));
  release();
  await waitOp(page, 'revise', 'late');
  await page.waitForTimeout(800);
  await r.snap('bridge-desk-card-late-band-revised', await ops(page));
  await page.unroute('**/api/v1/scan/actions');
}
