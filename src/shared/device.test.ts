import { describe, expect, it } from 'vitest';
import { HOLDER_COPY } from './copy/holder.ts';
import { addLine, canAddToWallet, passDevice, showsAddQr } from './device.ts';

const SAFARI = 'Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ${SAFARI}`;
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const GSA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0 Mobile/15E148';
const FB_ANDROID = 'Mozilla/5.0 (Linux; Android 14) [FBAN/FB4A;FBAV/450.0]';

describe('passDevice', () => {
  it.each([
    [IPHONE, undefined, 'iphone', false],
    [`Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) ${SAFARI}`, 0, 'iphone', false],
    [MAC, undefined, 'mac', false],
    [MAC, 0, 'mac', false],
    // iPadOS asks for the desktop site with a Mac agent; its touch points give it away.
    [MAC, 5, 'other', false],
    [`Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) ${SAFARI}`, 5, 'other', false],
    [FB_ANDROID, 5, 'other', true],
    [GSA, 5, 'iphone', true],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [LinkedInApp]',
      5,
      'iphone',
      true,
    ],
    [undefined, undefined, 'other', false],
  ])('%s (%s touch points)', (ua, touch, device, inApp) => {
    expect(passDevice(ua, touch)).toEqual({ device, inApp });
  });
});

describe('the add path', () => {
  it('adds on iPhone and Mac; shows the QR wherever it is not the phone', () => {
    expect(['iphone', 'mac', 'other'].map((d) => canAddToWallet(d as never))).toEqual([
      true,
      true,
      false,
    ]);
    expect(['iphone', 'mac', 'other'].map((d) => showsAddQr(d as never))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('says how to add where this browser cannot', () => {
    expect(addLine(passDevice(IPHONE))).toBeNull();
    expect(addLine(passDevice(MAC))).toBeNull();
    expect(addLine(passDevice(MAC, 5))).toBe(HOLDER_COPY.openOnApple);
    expect(addLine(passDevice(GSA))).toBe(HOLDER_COPY.openInSafari);
    // Safari means nothing on Android: an in-app view there still goes to an Apple device.
    expect(addLine(passDevice(FB_ANDROID))).toBe(HOLDER_COPY.openOnApple);
  });
});
