// Gives the admin pages scans to show: a few check-ins, a repeat and a refusal, made through the
// device API by a scanner paired without a browser (the way a native app would).
import { randomBytes } from 'node:crypto';
import { request } from '@playwright/test';
import { newPairingCode, type ScanApi } from './scan-api.ts';

const uuidv7 = (): string => {
  const ts = Date.now().toString(16).padStart(12, '0');
  const r = randomBytes(10).toString('hex');
  const variant = ((Number.parseInt(r.charAt(3), 16) & 3) | 8).toString(16);
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${r.slice(0, 3)}-${variant}${r.slice(4, 7)}-${r.slice(7, 19)}`;
};

/** The QR text of the first `n` active passes of an org, filtered to one template when given. */
export async function codes(api: ScanApi, orgId: string, n: number, templateId?: string) {
  const list = await api.get(`/api/v1/passes?orgId=${orgId}&limit=50&status=active`);
  const picked = (list.items as { id: string; templateId: string }[])
    .filter((p) => !templateId || p.templateId === templateId)
    .slice(0, n);
  const out: string[] = [];
  for (const p of picked) {
    const detail = await api.get(`/api/v1/passes/${p.id}`);
    const message = detail.passJson?.barcodes?.[0]?.message;
    if (typeof message === 'string') out.push(message);
  }
  return out;
}

/** Pairs `scannerId` as an app would and scans `n` passes once, plus a repeat and an unknown code. */
export async function seedScans(
  base: string,
  api: ScanApi,
  scannerId: string,
  orgId: string,
  n: number,
): Promise<string> {
  const list = await api.get(`/api/v1/scans?orgId=${orgId}&scannerId=${scannerId}&limit=1`);
  if ((list.items as unknown[]).length > 0) return 'exists';
  const device = await request.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  try {
    const paired = await device.post('/api/v1/scan/pair', {
      data: { code: await newPairingCode(api, scannerId) },
    });
    if (!paired.ok()) throw new Error(`pair ${paired.status()}`);
    const session = (await (await device.get('/api/v1/scan/session')).json()) as {
      csrfToken: string;
    };
    const scan = async (code: string) =>
      device.post('/api/v1/scan/actions', {
        headers: { 'x-csrf-token': session.csrfToken },
        data: {
          idempotencyKey: uuidv7(),
          input: { code, method: 'wedge' },
          clientTs: Date.now(),
          actionId: 'auto',
        },
      });
    const found = await codes(api, orgId, n);
    for (const code of [...found, ...found.slice(0, 1), 'NOT-A-PASS-0000']) {
      const res = await scan(code);
      if (!res.ok()) throw new Error(`scan ${res.status()} ${(await res.text()).slice(0, 160)}`);
    }
    return `${found.length} check-ins, a repeat and a refusal`;
  } finally {
    await device.dispose();
  }
}
