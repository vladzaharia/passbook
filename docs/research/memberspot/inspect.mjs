import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Summarize captured payload structure without copying member or token values.
// The report still contains endpoint paths and field names: keep it private.
export function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (depth >= 6) return Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(value)) return { type: 'array', examples: value.slice(0, 3).map(item => shape(item, depth + 1)) };
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, shape(item, depth + 1)]));
  }
  return typeof value;
}

export function summarize(capture) {
  const endpoints = new Map();
  for (const request of capture.requests) {
    if (!['xhr', 'fetch', 'document'].includes(request.resourceType)) continue;
    const key = `${request.method} ${request.url}`;
    const endpoint = endpoints.get(key) || {
      method: request.method, url: request.url, phases: new Set(), statuses: new Set(),
      requestHeaderNames: new Set(), setCookieNames: new Set(), bodyFiles: new Set(),
    };
    endpoint.phases.add(request.phase);
    endpoint.statuses.add(request.status);
    for (const name of request.requestHeaderNames || []) endpoint.requestHeaderNames.add(name);
    for (const name of request.setCookieNames || []) endpoint.setCookieNames.add(name);
    if (request.bodyFile) endpoint.bodyFiles.add(request.bodyFile);
    endpoints.set(key, endpoint);
  }
  return [...endpoints.values()].map(endpoint => Object.fromEntries(
    Object.entries(endpoint).map(([key, value]) => [key, value instanceof Set ? [...value] : value])
  ));
}

async function inspect() {
  const root = dirname(fileURLToPath(import.meta.url));
  let directory = process.argv[2];
  if (directory === '--help') {
    console.log('Usage: node investigations/memberspot/inspect.mjs [capture-directory]\nDefaults to the newest capture for account label local. Saves report.json beside the private capture.');
    return;
  }
  if (!directory) {
    const captures = join(root, '.private/local/captures');
    const names = (await readdir(captures, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    if (!names.length) throw new Error('No captures found. Run capture.mjs first.');
    directory = join(captures, names.at(-1));
  }
  directory = resolve(directory);
  const capture = JSON.parse(await readFile(join(directory, 'traffic.json'), 'utf8'));
  const endpoints = summarize(capture);
  for (const endpoint of endpoints) {
    endpoint.jsonShapes = [];
    for (const file of endpoint.bodyFiles) {
      // Accept only files emitted by capture.mjs, never a path supplied by a page.
      if (!/^response-\d{4}\.json$/.test(file)) continue;
      try {
        const payload = JSON.parse(await readFile(join(directory, file), 'utf8'));
        endpoint.jsonShapes.push({ file, shape: shape(payload) });
      } catch { endpoint.jsonShapes.push({ file, error: 'Unable to parse captured JSON' }); }
    }
  }
  let cookies = [];
  try { cookies = JSON.parse(await readFile(join(directory, 'cookies.json'), 'utf8')); } catch { /* partial capture */ }
  const report = {
    origin: capture.origin, recordedAt: capture.recordedAt, completed: capture.completed,
    recordingStarted: capture.recordingStarted, failures: capture.failures,
    otherOrigins: capture.otherOrigins, cookies, endpoints,
    limitations: [
      'HTTP 200 or a cookie is not proof of an authenticated member response.',
      'Query values, request bodies and header values are intentionally absent.',
      'Payload values and account ownership must be checked privately before mapping fields.',
      'Cookies with expires=-1 are session cookies; persistent profile reuse may not restore them.',
      'Member sessions reportedly do not coexist; this capture is not a basis for unattended member-session polling.',
      'Login, session lifetime, CSRF and fixed-egress requirements need live verification.',
    ],
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Summarized ${endpoints.length} endpoints. Private report: ${join(directory, 'report.json')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inspect().catch(error => {
    console.error(error.code === 'ENOENT' ? 'No capture found. Run capture.mjs first.' : error.message);
    process.exitCode = 1;
  });
}
