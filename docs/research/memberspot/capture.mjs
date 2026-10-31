import { createRequire } from 'node:module';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { once } from 'node:events';

const root = dirname(fileURLToPath(import.meta.url));
const origin = 'https://henrysgymnasium.thememberspot.com';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node investigations/memberspot/capture.mjs [account-label]

Opens a dedicated browser profile. Sign in and verify in the browser, then
press Enter in Terminal to start recording member-detail responses. Visit
your profile, membership, and member card, then press Enter again to save.
Developer capture only: signing in here may end the phone's MemberSpot session.
Do not run this as a background connector or to compete with phone usage.

All artifacts and browser state stay under investigations/memberspot/.private/.
The recorder omits submitted request bodies and header values. Response
captures and the browser profile may contain private details/session tokens.
PLAYWRIGHT_PACKAGE can point to an existing Playwright package.json.`);
  process.exit(0);
}
const account = args[0] || 'local';
if (args.length > 1 || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(account)) {
  throw new Error('Use a short account label containing lowercase letters, digits, underscores or hyphens.');
}
if (!process.stdin.isTTY) throw new Error('Run this command in an interactive Terminal.');

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PACKAGE,
    join(root, 'node_modules/playwright/package.json'),
    resolve(root, '../../node_modules/playwright/package.json'),
    // Reuse the installation already used by this workspace’s browser checks.
    resolve(root, '../../../polaris-key/node_modules/.pnpm/node_modules/playwright/package.json'),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return createRequire(path)('playwright');
  }
  throw new Error('Playwright was not found. Set PLAYWRIGHT_PACKAGE to its package.json, or install it in investigations/memberspot.');
}

process.umask(0o077);
const privateRoot = join(root, '.private');
const accountRoot = join(privateRoot, account);
const profile = join(accountRoot, 'browser-profile');
const run = join(accountRoot, 'captures', new Date().toISOString().replace(/[:.]/g, '-'));
for (const dir of [privateRoot, accountRoot, profile, run]) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
const save = (name, value) => writeFile(join(run, name), value, { mode: 0o600 });
const json = value => JSON.stringify(value, null, 2) + '\n';
function safeURL(value) {
  const url = new URL(value);
  url.hash = '';
  for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
  return url.href;
}
function cookieMetadata(cookies) {
  return cookies.map(({ name, domain, path, expires, httpOnly, secure, sameSite }) =>
    ({ name, domain, path, expires, httpOnly, secure, sameSite }));
}

const { chromium } = loadPlaywright();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
let context;
let recording = false;
let stopping = false;
let bytesWritten = 0;
let failures = 0;
let completed = false;
let stage = 'browser-start';
const traffic = [];
const otherOrigins = new Set();
const pending = new Set();
const maxBodyBytes = 2 * 1024 * 1024;
const maxTotalBytes = 32 * 1024 * 1024;

async function record(response) {
  const request = response.request();
  const url = new URL(response.url());
  if (url.origin !== origin) { otherOrigins.add(url.origin); return; }
  if (!['document', 'xhr', 'fetch', 'script'].includes(request.resourceType())) return;
  if (traffic.length >= 2000) return;
  const id = traffic.length + 1;
  const phase = recording ? 'details' : 'login';
  const entry = { id, phase, method: request.method(), url: safeURL(url),
    resourceType: request.resourceType(), status: response.status() };
  traffic.push(entry);
  const headers = await response.allHeaders();
  entry.contentType = headers['content-type'] || '';
  // Header names identify Cookie/Bearer/CSRF mechanisms without recording values.
  entry.requestHeaderNames = Object.keys(await request.allHeaders()).sort();
  entry.responseHeaderNames = Object.keys(headers).sort();
  if (headers.location) entry.location = safeURL(new URL(headers.location, url));
  entry.setCookieNames = (await response.headersArray())
    .filter(header => header.name.toLowerCase() === 'set-cookie')
    .map(header => header.value.split('=', 1)[0]);
  const script = request.resourceType() === 'script';
  const readable = /json|text\/html/.test(entry.contentType);
  // Public client scripts are useful before login. Other bodies are captured
  // only after the operator has completed verification and armed recording.
  if ((!script && (phase !== 'details' || !readable)) || !response.ok()) return;
  if (Number(headers['content-length']) > maxBodyBytes || bytesWritten >= maxTotalBytes) {
    entry.bodySkipped = 'size-limit'; return;
  }
  const body = await response.body();
  if (body.byteLength > maxBodyBytes || bytesWritten + body.byteLength > maxTotalBytes) {
    entry.bodySkipped = 'size-limit'; return;
  }
  bytesWritten += body.byteLength;
  const extension = script ? 'js' : /json/.test(entry.contentType) ? 'json' : 'html';
  entry.bodyFile = `response-${String(id).padStart(4, '0')}.${extension}`;
  await save(entry.bodyFile, body);
}

async function finish() {
  if (stopping) return;
  stopping = true;
  if (context) {
    // Stop new work, then drain the captures that are already in flight.
    context.removeAllListeners('response');
    await Promise.allSettled([...pending]);
    const cookies = await context.cookies(origin).catch(() => []);
    await save('cookies.json', json(cookieMetadata(cookies)));
    for (const [i, page] of context.pages().entries()) {
      if (new URL(page.url()).origin !== origin) continue;
      await save(`page-${i}.html`, await page.content()).catch(() => { failures++; });
    }
    await save('traffic.json', json({ origin, recordedAt: new Date().toISOString(),
      account, completed, recordingStarted: recording, failures, otherOrigins: [...otherOrigins], requests: traffic }));
    // Retain the profile for deliberate developer investigation only. Member
    // sessions do not coexist reliably; this must not become a polling worker.
    await context.close();
  }
  terminal.close();
  if (context) console.log(`Saved ${completed ? 'complete' : 'partial'} private capture: ${run}`);
  if (failures) console.log(`${failures} response(s) or page(s) could not be captured; see traffic.json for available evidence.`);
}

try {
  console.log('Developer capture only: MemberSpot sessions do not coexist reliably.');
  console.log('Signing in here may end the phone session. Do not use this for background synchronization.');
  context = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
  });
  const closed = once(context, 'close').then(() => { throw new Error('The browser closed before the capture was saved.'); });
  // Attach a rejection handler while page navigation is in progress.
  closed.catch(() => {});
  context.on('response', response => {
    const task = record(response).catch(() => { failures++; }).finally(() => pending.delete(task));
    pending.add(task);
  });
  const page = context.pages()[0] || await context.newPage();
  stage = 'portal-navigation';
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await save('page-start.html', await page.content());
  await save('cookies-start.json', json(cookieMetadata(await context.cookies(origin))));
  stage = 'manual-sign-in';
  console.log('Complete sign-in and any verification in the browser. If already signed in, keep that session.');
  console.log('Passwords and verification codes belong in the portal, not this Terminal.');
  await Promise.race([terminal.question('When signed in, press Enter to start recording details: '), closed]);
  recording = true;
  stage = 'member-details';
  console.log('Open or reload your profile, membership, and member-card pages. Avoid payment or account-change actions.');
  await Promise.race([terminal.question('When finished, press Enter to save and close the browser: '), closed]);
  completed = true;
  stage = 'save';
  await finish();
} catch {
  console.error(`Capture did not complete (${stage}). Check network access and that this dedicated profile is not already open.`);
  await finish().catch(() => { terminal.close(); });
  process.exitCode = 1;
}
