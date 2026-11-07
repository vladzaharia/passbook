import { expect, type Page } from '@playwright/test';
import bwipjs from 'bwip-js/node';
import { type Api, createPass, GENERIC, uid } from './api.ts';

export const cameraFormats = [
  ['qr', 'QR', 'qrcode'],
  ['pdf417', 'PDF417', 'pdf417'],
  ['aztec', 'Aztec', 'azteccode'],
  ['code128', 'Code128', 'code128'],
  ['code39', 'Code39', 'code39'],
  ['codabar', 'Codabar', 'rationalizedCodabar'],
  ['ean13', 'EAN13', 'ean13'],
  ['itf', 'I2of5', 'interleaved2of5'],
] as const;

export async function cameraFixture(api: Api, orgId: string, reader: 'none' | 'barcode' = 'none') {
  const templates: string[] = [];
  for (const group of [
    cameraFormats.filter((f) => f[0] !== 'ean13'),
    cameraFormats.filter((f) => f[0] === 'ean13'),
  ]) {
    const cloned = await api.send(
      'POST',
      `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`,
      { orgId, name: uid('Camera formats') },
    );
    const detail = await api.get(`/api/v1/templates/${cloned.id}/versions/${cloned.activeVersion}`);
    const sample = group[0]?.[0] === 'ean13' ? '5901234123457' : '123456789012';
    detail.manifest.sample.memberId = sample;
    detail.passJson.barcodes = group.map((f) => ({
      format: `PKBarcodeFormat${f[1]}`,
      message: sample,
      messageEncoding: 'iso-8859-1',
    }));
    const saved = await api.send('POST', `/api/v1/templates/${cloned.id}/versions`, {
      passJson: detail.passJson,
      manifest: detail.manifest,
      assets: detail.assets.map((a: { name: string; sha1: string }) => ({
        name: a.name,
        sha1: a.sha1,
      })),
      activate: true,
    });
    expect(saved.saved, JSON.stringify(saved.report)).toBe(true);
    templates.push(cloned.id);
  }
  const items = [];
  for (const [format, , bcid] of cameraFormats) {
    let code = `8${Math.floor(Math.random() * 1e11)
      .toString()
      .padStart(11, '0')}`;
    if (format === 'ean13') {
      const sum = [...code].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
      code += (10 - (sum % 10)) % 10;
    }
    if (format === 'codabar') code = `A${code}A`;
    const pass = await createPass(api, orgId, {
      templateId: templates[format === 'ean13' ? 1 : 0],
      memberId: code,
      holder: `Camera ${format}`,
    });
    const png = await bwipjs.toBuffer({
      bcid,
      text: code,
      scale: 4,
      padding: 16,
      ...(format === 'qr' || format === 'aztec' ? {} : { height: 22 }),
    });
    items.push({
      format,
      passId: pass.id as string,
      image: `data:image/png;base64,${png.toString('base64')}`,
    });
  }
  const scanner = await api.send('POST', '/api/v1/scanners', {
    orgId,
    name: uid('Camera suite'),
    kind: 'device',
    accepts: { templateIds: templates },
    timeZone: 'UTC',
    settings: { lookup: true, reader },
  });
  return { scanner, items };
}

/** Feed pixels into getUserMedia; the production Worker and WASM decoder run unchanged. */
export async function installCamera(
  page: Page,
  images: string[],
  options: { enumerateFails?: boolean; constraintFails?: boolean; permissionDenied?: boolean } = {},
) {
  await page.addInitScript(
    ({ images, options }) => {
      const state = {
        index: -1,
        rotation: 0,
        portrait: false,
        x: 0.5,
        y: 0.5,
        denied: options.permissionDenied ?? false,
        attempts: 0,
        frames: 0,
        playbackError: '',
        track: null as MediaStreamTrack | null,
        constraints: [] as MediaStreamConstraints[],
      };
      Object.assign(window, { cameraTest: state });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        return play.call(this).catch((error) => {
          state.playbackError = `${error.name}: ${error.message}; muted=${this.muted}; inline=${(this as HTMLVideoElement).playsInline}`;
          throw error;
        });
      };
      if (options.enumerateFails)
        MediaDevices.prototype.enumerateDevices = async () => {
          throw new DOMException('Optional device list denied', 'NotAllowedError');
        };
      MediaDevices.prototype.getUserMedia = async (constraints) => {
        state.attempts++;
        state.constraints.push(constraints ?? {});
        if (state.denied) throw new DOMException('Camera denied', 'NotAllowedError');
        if (options.constraintFails && state.attempts === 1)
          throw new DOMException('No selected device', 'OverconstrainedError');
        const loaded = await Promise.all(
          images.map(async (src) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            return img;
          }),
        );
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Missing test canvas');
        const draw = () => {
          state.frames++;
          canvas.width = state.portrait ? 720 : 1280;
          canvas.height = state.portrait ? 1280 : 720;
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const image = loaded[state.index];
          if (!image) return;
          const max = state.rotation % 180 ? canvas.height * 0.8 : canvas.width * 0.8;
          const scale = Math.min(
            max / image.width,
            (Math.min(canvas.width, canvas.height) * 0.65) / image.height,
            1.6,
          );
          ctx.save();
          const sideways = state.rotation % 180 !== 0;
          const halfW = ((sideways ? image.height : image.width) * scale) / 2;
          const halfH = ((sideways ? image.width : image.height) * scale) / 2;
          ctx.translate(
            Math.max(halfW + 8, Math.min(canvas.width - halfW - 8, canvas.width * state.x)),
            Math.max(halfH + 8, Math.min(canvas.height - halfH - 8, canvas.height * state.y)),
          );
          ctx.rotate((state.rotation * Math.PI) / 180);
          ctx.drawImage(
            image,
            (-image.width * scale) / 2,
            (-image.height * scale) / 2,
            image.width * scale,
            image.height * scale,
          );
          ctx.restore();
        };
        draw();
        const timer = setInterval(draw, 60);
        const stream = canvas.captureStream(16);
        state.track = stream.getVideoTracks()[0] ?? null;
        state.track?.addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    },
    { images, options },
  );
}

export async function showBarcode(
  page: Page,
  index: number,
  rotation = 0,
  portrait = false,
  position = { x: 0.5, y: 0.5 },
) {
  await page.evaluate(
    ({ index, rotation, portrait, position }) => {
      Object.assign((window as unknown as { cameraTest: object }).cameraTest, {
        index,
        rotation,
        portrait,
        ...position,
      });
    },
    { index, rotation, portrait, position },
  );
}

export async function pairCamera(page: Page, code: string) {
  await page.goto(`https://localhost:5175/scan#pair=${encodeURIComponent(code)}`);
  await expect(page.getByRole('heading', { name: 'Pair this device?' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByTestId('scan-start').click();
}
