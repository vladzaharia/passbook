import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeOrg,
  makeSession,
  makeTemplate,
  makeUser,
  type OrgRow,
  persistTemplate,
  type SessionFixture,
  type UserRow,
} from '../../../../test/helpers/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import type { InMemoryTemplateRegistry } from '../../../passkit/template/in-memory-registry.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { qrDataUri } from '../../../web/portal/holder-qr.tsx';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { fakeLimiter, harness, ORIGIN, type TestHarness } from '../auth/test-support.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { rotateLink } from '../passes/pass-service-delivery.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { upsertAsset } from '../passes/repo-history-assets.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { key, ORIGIN as SCAN_ORIGIN, setupScanKit } from '../scan/test-kit.ts';
import { presentationForPass } from './presentation.ts';
import { assertPassSnapshot, capturePassSnapshot } from './snapshot.ts';

const NOW = Date.UTC(2026, 10, 9, 12);
const PRIMARY = 'PRIMARY-CREDENTIAL-42';
const ALT_TEXT = 'PRESENTATION-ALT-TEXT-42';
const SECONDARY = 'SECONDARY-CREDENTIAL-43';
const LEGACY = 'LEGACY-CREDENTIAL-44';
// Storage lasts for the whole file and scan codes are unique, so each case draws a new one.
let SCAN_CODE = '';

let h: TestHarness;
let f: Fixtures;
let ctx: ServiceContext;
let org: OrgRow;
let user: UserRow;
let session: SessionFixture;
let template: ResolvedTemplate;
let templateRegistry: InMemoryTemplateRegistry;

beforeEach(async () => {
  h = await harness(
    { RL_PUBLIC: fakeLimiter(1000) as unknown as RateLimit },
    { clock: new ManualClock(NOW) },
  );
  f = fixtures(h.env, h.clock);
  SCAN_CODE = `S${f.ids.id().replaceAll('-', '').toUpperCase()}`.slice(0, 26);
  ctx = createServiceContext(h.env, { clock: h.clock });
  org = await makeOrg(f, { name: 'Cedar Gate' });
  user = await makeUser(f);
  session = await makeSession(f, { userId: user.id });
  ({ resolved: template, registry: templateRegistry } = makeTemplate({
    id: `presentation-${f.ids.token(6)}`,
  }));
});

afterEach(() => h.restore());

/** Store the pass.json and scan code just as a published pass would have them. */
async function passWith(
  options: {
    json?: Record<string, unknown>;
    scanCode?: string | null;
    ownerId?: string;
    mode?: 'live' | 'test';
    holderEmail?: string;
    title?: string;
  } = {},
): Promise<Pass> {
  await ensurePlatformIdentity(f.env, f.clock.now());
  await persistTemplate(f, template, { registry: templateRegistry });
  const id = f.ids.id();
  const objectKey = `passes/${id}/v1-${f.ids.token(4)}.pkpass`;
  await h.env.BUCKET.put(objectKey, new Uint8Array([1, 2, 3]));
  await run(
    h.env.DB,
    `INSERT INTO passes
    (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
     web_service_url, personalization, holder_email, owner_user_id, scan_code, display_title, mode,
     object_key, modified_at, created_at, pending_cause)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create')`,
    [
      id,
      org.id,
      PLATFORM_IDENTITY_ID,
      f.ids.token(16),
      template.id,
      template.version,
      f.ids.token(),
      f.ids.token(),
      `${f.env.PUBLIC_BASE_URL}/wallet`,
      JSON.stringify({ memberName: 'Alex Morgan' }),
      options.holderEmail ?? null,
      options.ownerId ?? user.id,
      options.scanCode === undefined ? SCAN_CODE : options.scanCode,
      options.title ?? 'Guest admission',
      options.mode ?? 'live',
      objectKey,
      f.clock.now(),
      f.clock.now(),
    ],
  );
  // The pass_created trigger inserts the current version.
  const version = await run(h.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
    JSON.stringify({
      formatVersion: 1,
      organizationName: org.name,
      description: 'Admission',
      generic: { primaryFields: [] },
      ...options.json,
    }),
    id,
  ]);
  expect(version.changes).toBe(1);
  const pass = await getPass(h.env.DB, id);
  if (!pass) throw new Error('Pass fixture was not stored');
  return pass;
}

const publicPath = (pass: Pass) => `/p/${pass.downloadToken}/barcode`;
const ownerPath = (pass: Pass) => `/api/v1/me/passes/${pass.id}/barcode`;
const publicGet = (path: string) => h.call(path, { headers: { accept: 'text/html' } });
const ownerGet = (path: string, headers = session.headers) =>
  h.call(path, { headers: { ...headers, accept: 'application/json' } });

function bodyOf(html: string): string {
  const match = /<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i.exec(html);
  expect(match, 'HTML body').not.toBeNull();
  return match?.[1] ?? '';
}

async function presentationHtml(res: Response, secrets: string[]): Promise<string> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/html\b/i);
  expect(res.headers.get('cache-control')).toContain('private');
  expect(res.headers.get('cache-control')).toContain('no-store');
  const html = await res.text();
  expect(html).toMatch(/<!doctype html>/i);
  expect(html).not.toMatch(/<script\b/i);
  const body = bodyOf(html);
  for (const secret of secrets) expect(body).not.toContain(secret);
  return html;
}

/** Compare the actual rendered paths with bwip's output for the expected bytes and symbology. */
function expectDrawing(
  html: string,
  bcid: string,
  label: string,
  options: Record<string, unknown>,
) {
  const figure = /<figure\b[^>]*data-format="([^"]+)"[^>]*>([\s\S]*?)<\/figure>/i.exec(
    bodyOf(html),
  );
  expect(figure, 'presentation barcode').not.toBeNull();
  expect(figure?.[1]).toBe(bcid);
  const svg = figure?.[2] ?? '';
  expect(svg).toMatch(/<svg\b[^>]*\brole="img"/i);
  expect(svg).toContain(`aria-label="${label} presentation barcode"`);
  const expected = toSvg({ bcid, paddingwidth: 0, paddingheight: 0, ...options });
  const paths = (markup: string) =>
    [...markup.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  const expectedPaths = paths(expected);
  expect(expectedPaths.length).toBeGreaterThan(0);
  expect(paths(svg)).toEqual(expectedPaths);
  expect(/\bviewBox="([^"]+)"/.exec(svg)?.[1]).toBe(/\bviewBox="([^"]+)"/.exec(expected)?.[1]);
}

async function expectUnavailable(res: Response, secrets: string[]) {
  const html = await presentationHtml(res, secrets);
  const body = bodyOf(html);
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  expect(text).toMatch(/barcode unavailable/i);
  expect(body).toMatch(/role="status"/);
  expect(body).not.toMatch(/<figure\b[^>]*class="presentation-figure"/);
}

async function expectDenied(res: Response, secrets: string[]) {
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  const body = await res.text();
  for (const secret of secrets) expect(body).not.toContain(secret);
  expect(body).not.toContain('class="presentation-figure"');
}

const primaryJson = {
  barcodes: [
    {
      format: 'PKBarcodeFormatCode128',
      message: PRIMARY,
      messageEncoding: 'iso-8859-1',
      altText: ALT_TEXT,
    },
    { format: 'PKBarcodeFormatQR', message: SECONDARY, messageEncoding: 'utf-8' },
  ],
  barcode: { format: 'PKBarcodeFormatPDF417', message: LEGACY, messageEncoding: 'utf-8' },
};

describe('presentation barcode', () => {
  it('uses the first PassKit barcode exactly, ahead of later, legacy and scan codes', async () => {
    const pass = await passWith({ json: primaryJson });
    expect(await presentationForPass(ctx, pass)).toEqual({
      orgName: 'Cedar Gate',
      passTitle: 'Guest admission',
      mode: 'live',
      barcode: {
        format: 'PKBarcodeFormatCode128',
        bcid: 'code128',
        message: PRIMARY,
        square: false,
        encoding: 'iso-8859-1',
      },
    });
    const detail = await ownerGet(`/api/v1/me/passes/${pass.id}`);
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as { passJson: Record<string, unknown> };
    expect(dto.passJson).toMatchObject(primaryJson);

    for (const res of [await publicGet(publicPath(pass)), await ownerGet(ownerPath(pass))]) {
      const html = await presentationHtml(res, [PRIMARY, SECONDARY, LEGACY, SCAN_CODE, ALT_TEXT]);
      expectDrawing(html, 'code128', 'Code 128', {
        text: PRIMARY,
        binarytext: true,
        height: 22,
      });
    }
  });

  it('uses the legacy PassKit barcode if there is no modern primary', async () => {
    const pass = await passWith({
      json: {
        barcodes: [],
        barcode: { format: 'PKBarcodeFormatQR', message: LEGACY, messageEncoding: 'utf-8' },
      },
    });
    expect((await presentationForPass(ctx, pass)).barcode).toEqual({
      format: 'PKBarcodeFormatQR',
      bcid: 'qrcode',
      message: LEGACY,
      square: true,
      encoding: 'utf-8',
    });
    const html = await presentationHtml(await publicGet(publicPath(pass)), [LEGACY, SCAN_CODE]);
    expectDrawing(html, 'qrcode', 'QR', { text: LEGACY });
  });

  it('projects only the persisted scan code as QR when neither PassKit barcode exists', async () => {
    const pass = await passWith({ json: { barcodes: [] } });
    expect((await presentationForPass(ctx, pass)).barcode).toEqual({
      format: 'PKBarcodeFormatQR',
      bcid: 'qrcode',
      message: SCAN_CODE,
      square: true,
      encoding: 'utf-8',
    });
    for (const res of [await publicGet(publicPath(pass)), await ownerGet(ownerPath(pass))]) {
      const html = await presentationHtml(res, [SCAN_CODE, pass.serial, pass.authToken]);
      expectDrawing(html, 'qrcode', 'QR', { text: SCAN_CODE });
    }
  });

  it('renders the declared ISO-8859-1 bytes, rather than silently changing them to UTF-8', async () => {
    const message = 'CAFÉ-CREDENTIAL';
    const pass = await passWith({
      json: {
        barcodes: [{ format: 'PKBarcodeFormatQR', message, messageEncoding: 'iso-8859-1' }],
      },
    });
    expect((await presentationForPass(ctx, pass)).barcode).toEqual({
      format: 'PKBarcodeFormatQR',
      bcid: 'qrcode',
      message,
      square: true,
      encoding: 'iso-8859-1',
    });
    const html = await presentationHtml(await publicGet(publicPath(pass)), [message, SCAN_CODE]);
    expectDrawing(html, 'qrcode', 'QR', { text: message, binarytext: true });
  });

  it('shows an unavailable state instead of inventing a code when no code was persisted', async () => {
    const pass = await passWith({ json: { barcodes: [] }, scanCode: null });
    expect((await presentationForPass(ctx, pass)).barcode).toBeNull();
    for (const res of [await publicGet(publicPath(pass)), await ownerGet(ownerPath(pass))]) {
      await expectUnavailable(res, [pass.serial, pass.authToken]);
    }
  });

  it.each([
    [
      'unknown format',
      { format: 'PKBarcodeFormatUnknown', message: PRIMARY, messageEncoding: 'utf-8' },
    ],
    ['empty message', { format: 'PKBarcodeFormatQR', message: '', messageEncoding: 'utf-8' }],
    ['missing message', { format: 'PKBarcodeFormatQR', messageEncoding: 'utf-8' }],
    ['non-string message', { format: 'PKBarcodeFormatQR', message: 17, messageEncoding: 'utf-8' }],
    ['empty encoding', { format: 'PKBarcodeFormatQR', message: PRIMARY, messageEncoding: '' }],
    ['invalid encoding', { format: 'PKBarcodeFormatQR', message: PRIMARY, messageEncoding: 17 }],
  ])('does not fall through an invalid primary (%s)', async (_name, primary) => {
    const pass = await passWith({
      json: {
        barcodes: [
          primary,
          { format: 'PKBarcodeFormatQR', message: SECONDARY, messageEncoding: 'utf-8' },
        ],
        barcode: { format: 'PKBarcodeFormatQR', message: LEGACY, messageEncoding: 'utf-8' },
      },
    });
    expect((await presentationForPass(ctx, pass)).barcode).toBeNull();
    for (const res of [await publicGet(publicPath(pass)), await ownerGet(ownerPath(pass))]) {
      await expectUnavailable(res, [PRIMARY, SECONDARY, LEGACY, SCAN_CODE]);
    }
  });

  it.each([
    ['invalid EAN-13 data', 'PKBarcodeFormatEAN13', '12AB34', 'utf-8'],
    ['unrepresentable Latin-1', 'PKBarcodeFormatQR', 'TICKET-🎫', 'iso-8859-1'],
    ['unknown character encoding', 'PKBarcodeFormatQR', PRIMARY, 'not-a-charset'],
    ['unsupported ISO-2022-JP', 'PKBarcodeFormatQR', '日本', 'ISO-2022-JP'],
  ])('does not replace unencodable content (%s)', async (_name, format, message, encoding) => {
    const pass = await passWith({
      json: {
        barcodes: [
          { format, message, messageEncoding: encoding },
          { format: 'PKBarcodeFormatQR', message: SECONDARY, messageEncoding: 'utf-8' },
        ],
        barcode: { format: 'PKBarcodeFormatQR', message: LEGACY, messageEncoding: 'utf-8' },
      },
    });
    expect((await presentationForPass(ctx, pass)).barcode).toMatchObject({
      format,
      message,
      encoding,
    });
    for (const res of [await publicGet(publicPath(pass)), await ownerGet(ownerPath(pass))]) {
      await expectUnavailable(res, [message, SECONDARY, LEGACY, SCAN_CODE]);
    }
  });

  it.each([
    'expired',
    'JSON-voided',
    'status-voided',
    'removed',
    'deleted',
    'suspended organization',
    'deleted organization',
  ])('denies credentials from an inactive pass (%s) on both routes', async (state) => {
    const json: Record<string, unknown> = { ...primaryJson };
    if (state === 'expired') json.expirationDate = '2026-01-01T00:00:00Z';
    if (state === 'JSON-voided') json.voided = true;
    const pass = await passWith({ json });
    if (state === 'status-voided') {
      await run(h.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    } else if (state === 'removed') {
      await run(h.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [NOW, pass.id]);
    } else if (state === 'deleted') {
      await run(h.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [NOW, pass.id]);
    } else if (state === 'suspended organization' || state === 'deleted organization') {
      await run(h.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [
        state === 'suspended organization' ? 'suspended' : 'deleted',
        org.id,
      ]);
    }
    for (const res of [await publicGet(publicPath(pass)), await ownerGet(ownerPath(pass))]) {
      await expectDenied(res, [PRIMARY, SECONDARY, LEGACY, SCAN_CODE]);
    }

    const canBeMissing = state === 'deleted' || state.endsWith('organization');
    const detail = await ownerGet(`/api/v1/me/passes/${pass.id}`);
    if (canBeMissing) expect([200, 404]).toContain(detail.status);
    else expect(detail.status).toBe(200);
    if (detail.status === 200) {
      const dto = (await detail.json()) as { passJson: Record<string, unknown> };
      expect(dto.passJson).not.toHaveProperty('barcode');
      expect(dto.passJson).not.toHaveProperty('barcodes');
      const json = JSON.stringify(dto.passJson);
      for (const secret of [PRIMARY, SECONDARY, LEGACY, SCAN_CODE, ALT_TEXT])
        expect(json).not.toContain(secret);
    }

    const preview = await publicGet(`/p/${pass.downloadToken}`);
    expect(preview.status).toBe(canBeMissing ? 404 : 200);
    const previewHtml = await preview.text();
    for (const secret of [PRIMARY, SECONDARY, LEGACY, SCAN_CODE, ALT_TEXT])
      expect(previewHtml).not.toContain(secret);
    expect(previewHtml).not.toMatch(/<figure\b[^>]*class="pc-barcode"/);
    const primaryPath = /<path\b[^>]*\sd="([^"]+)"/.exec(
      toSvg({
        bcid: 'code128',
        text: PRIMARY,
        binarytext: true,
        paddingwidth: 0,
        paddingheight: 0,
        height: 12,
      }),
    )?.[1];
    expect(primaryPath).toBeTruthy();
    expect(previewHtml).not.toContain(`d="${primaryPath}"`);
  });

  it('quarantines a legacy test pass across public links, assets and the owner portfolio', async () => {
    const holder = 'PRIVATE-HOLDER-93';
    const email = 'private-holder@example.test';
    const fileSecret = `PRIVATE-PKPASS-${holder}`;
    const pass = await passWith({
      mode: 'test',
      holderEmail: email,
      title: holder,
      json: {
        ...primaryJson,
        generic: { primaryFields: [{ key: 'name', label: 'Member', value: holder }] },
      },
    });
    await h.env.BUCKET.put(pass.objectKey, fileSecret);
    const sha1 = await sha1Hex(ICON_PNG);
    const assetNames = ['icon.png', 'logo.png', 'strip.png', 'thumbnail@3x.png'];
    const assetEtags = new Map<string, string>();
    for (const name of assetNames) {
      const r2Key = `presentation-assets/${pass.id}/${name}`;
      await h.env.BUCKET.put(r2Key, ICON_PNG);
      await upsertAsset(h.env.DB, pass.id, {
        name,
        r2Key,
        sha1,
        size: ICON_PNG.length,
        width: 38,
        height: 38,
        crc32: null,
        createdAt: NOW,
      });
    }
    const safe = await passWith({ scanCode: null });
    const current = await getPass(h.env.DB, pass.id);
    if (!current) throw new Error('Test pass fixture was not stored');
    const pagePath = `/p/${pass.downloadToken}`;

    const preview = await publicGet(pagePath);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain(holder);
    await presentationHtml(await publicGet(publicPath(pass)), [PRIMARY, SCAN_CODE]);
    await presentationHtml(await ownerGet(ownerPath(pass)), [PRIMARY, SCAN_CODE]);
    const file = await h.call(`${pagePath}/pass.pkpass`);
    expect(file.status).toBe(200);
    const fileEtag = file.headers.get('etag') ?? '*';
    expect(await file.text()).toBe(fileSecret);
    for (const name of assetNames) {
      const response = await h.call(`${pagePath}/assets/${name}`);
      expect(response.status).toBe(200);
      assetEtags.set(name, response.headers.get('etag') ?? '*');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(ICON_PNG);
    }
    const detail = await ownerGet(`/api/v1/me/passes/${pass.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain(holder);
    const beforeList = await ownerGet('/api/v1/me/passes');
    expect(beforeList.status).toBe(200);
    const before = (await beforeList.json()) as { items: { id: string }[] };
    expect(before.items.map((item) => item.id)).toContain(pass.id);

    const snapshot = await capturePassSnapshot(ctx, current);
    await expect(assertPassSnapshot(ctx, snapshot)).resolves.toBeUndefined();
    await run(h.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    await expect(assertPassSnapshot(ctx, snapshot)).rejects.toMatchObject({ status: 404 });
    await expect(capturePassSnapshot(ctx, current)).rejects.toMatchObject({ status: 404 });

    const secrets = [
      holder,
      email,
      fileSecret,
      PRIMARY,
      SECONDARY,
      LEGACY,
      ALT_TEXT,
      SCAN_CODE,
      pass.authToken,
    ];
    for (const path of [pagePath, publicPath(pass), `${pagePath}/pass.pkpass`]) {
      const response = await h.call(path);
      expect(response.status).toBe(404);
      response.headers.forEach((value) => {
        for (const secret of secrets) expect(value).not.toContain(secret);
      });
      await expectDenied(response, secrets);
    }
    const conditionalFile = await h.call(`${pagePath}/pass.pkpass`, {
      headers: { 'if-none-match': fileEtag },
    });
    expect(conditionalFile.status).toBe(404);
    await expectDenied(conditionalFile, secrets);
    for (const name of assetNames) {
      const requests: Record<string, string>[] = [
        {},
        { 'if-none-match': assetEtags.get(name) ?? '*' },
      ];
      for (const headers of requests) {
        const response = await h.call(`${pagePath}/assets/${name}`, { headers });
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).not.toContain('image/png');
        await expectDenied(response, secrets);
      }
    }
    for (const path of [ownerPath(pass), `/api/v1/me/passes/${pass.id}`]) {
      const response = await ownerGet(path);
      expect(response.status).toBe(404);
      await expectDenied(response, secrets);
    }
    const list = await ownerGet('/api/v1/me/passes');
    expect(list.status).toBe(200);
    const listText = await list.text();
    for (const secret of secrets) expect(listText).not.toContain(secret);
    const after = JSON.parse(listText) as { items: { id: string }[] };
    expect(after.items.map((item) => item.id)).toEqual([safe.id]);
  });

  it('requires a real session and checks ownership on the holder endpoint', async () => {
    const pass = await passWith({ json: primaryJson });
    const stranger = await makeUser(f);
    const strangerSession = await makeSession(f, { userId: stranger.id });
    const foreign = await ownerGet(ownerPath(pass), strangerSession.headers);
    expect(foreign.status).toBe(404);
    await expectDenied(foreign, [PRIMARY, SECONDARY, LEGACY, SCAN_CODE]);
    const anonymous = await h.call(ownerPath(pass));
    expect(anonymous.status).toBe(401);
    await expectDenied(anonymous, [PRIMARY, SECONDARY, LEGACY, SCAN_CODE]);

    const mine = await presentationHtml(await ownerGet(ownerPath(pass)), [PRIMARY, SCAN_CODE]);
    expectDrawing(mine, 'code128', 'Code 128', {
      text: PRIMARY,
      binarytext: true,
      height: 22,
    });
  });

  it('denies malformed, unknown and rotated bearer links but accepts the new link', async () => {
    const pass = await passWith({ json: primaryJson });
    await presentationHtml(await publicGet(publicPath(pass)), [PRIMARY, SCAN_CODE]);
    const rotated = await rotateLink(ctx, { type: 'user', id: user.id }, pass.id, null);
    for (const path of ['/p/short/barcode', `/p/${'z'.repeat(43)}/barcode`, publicPath(pass)]) {
      const res = await publicGet(path);
      expect(res.status).toBe(404);
      await expectDenied(res, [PRIMARY, SECONDARY, LEGACY, SCAN_CODE]);
    }
    const html = await presentationHtml(
      await publicGet(`${new URL(rotated.publicUrl).pathname}/barcode`),
      [PRIMARY, SCAN_CODE],
    );
    expectDrawing(html, 'code128', 'Code 128', {
      text: PRIMARY,
      binarytext: true,
      height: 22,
    });
  });

  it('keeps the page-opening QR distinct from the presentation action', async () => {
    const pass = await passWith({ json: primaryJson });
    const page = `/p/${pass.downloadToken}`;
    const res = await h.call(page, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36',
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="${page}/barcode"`);
    expect(html).toMatch(/<figure\b[^>]*class="pc-barcode"[^>]*data-format="code128"/);
    expect(html).toContain(ALT_TEXT);
    expect(html).toContain(qrDataUri(toSvg, `${ORIGIN}${page}`));
    expect(html).not.toContain(qrDataUri(toSvg, PRIMARY));
    expect(html).toContain('Scan with the camera.');
  });

  it.each(['primary', 'persisted'])(
    'presents the %s credential without bypassing scanner authority',
    async (source) => {
      const kit = await setupScanKit();
      kit.clock.set(NOW);
      const actions = [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] as const;
      const template = kit.registry.add({
        id: `presentation-scan-${kit.fx.ids.token(6)}`,
        orgId: kit.org.id,
        manifest: { ...kit.template.manifest, scan: { actions: [...actions] } },
        passJson: {
          ...kit.template.passJson,
          ...(source === 'primary'
            ? {
                barcodes: [
                  { format: 'PKBarcodeFormatQR', message: PRIMARY, messageEncoding: 'utf-8' },
                ],
              }
            : {}),
        },
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, template, { registry: kit.registry });
      await approveAppleRelease(kit, { templateId: template.id, version: template.version });
      const pass = await kit.scanPass(template.id);
      const barcode = (await presentationForPass(kit.ctx, pass)).barcode;
      expect(barcode).not.toBeNull();
      if (!barcode) throw new Error('Expected a presentation credential');
      expect(barcode).toMatchObject({
        format: 'PKBarcodeFormatQR',
        message: source === 'primary' ? PRIMARY : pass.scanCode,
        encoding: 'utf-8',
      });
      if (source === 'primary') expect(barcode.message).not.toBe(pass.scanCode);

      const app = createApp({ stores: fakeAuth(SCAN_ORIGIN).stores, clock: kit.clock });
      const page = await app.request(`${SCAN_ORIGIN}${publicPath(pass)}`, {}, kit.env);
      const html = await presentationHtml(page, [barcode.message]);
      expectDrawing(html, 'qrcode', 'QR', { text: barcode.message });

      const input = () => ({
        idempotencyKey: key(),
        input: { code: barcode.message, method: 'camera' },
        clientTs: kit.clock.now(),
      });
      // The CSRF origin check runs before authentication, so the request carries its origin.
      const unauthenticated = await kit.post({ origin: SCAN_ORIGIN }, '/resolve', input());
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toMatchObject({ code: 'SCANNER_UNAUTHENTICATED' });

      const other = await makeOrg(kit.fx, { name: 'Other organization' });
      const otherTemplate = await kit.scanTemplate(
        'Other entry',
        { actions: [...actions] },
        { orgId: other.id },
      );
      const foreign = await kit.scanner({ orgId: other.id, templateIds: [otherTemplate] });
      const denied = await kit.post(foreign.headers, '/resolve', input());
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        card: null,
        display: null,
      });

      const scanner = await kit.scanner({ templateIds: [template.id] });
      const accepted = await kit.post(scanner.headers, '/resolve', input());
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    },
  );
});
