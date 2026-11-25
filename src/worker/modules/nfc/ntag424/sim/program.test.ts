import { describe, expect, it } from 'vitest';
import { bytesToHex, verifySun } from '../../sun.ts';
import { parseSunUrl } from '../../sun-url.ts';
import { authFirstApdu } from '../ev2.ts';
import { checkResponse, getFileSettings } from '../secure-messaging.ts';
import { countingRandom, testPlan, ZERO16 } from './fixtures.ts';
import { authenticate, programTag, readUrl } from './program.ts';
import { RelayServer } from './relay-server.ts';
import { Ntag424Sim } from './tag.ts';

const sendOf = (sim: Ntag424Sim) => (apdu: Uint8Array) => sim.transceive(apdu);
const keyset = (k: Uint8Array[]) => ({
  metaKey: k[1] as Uint8Array,
  fileKey: k[2] as Uint8Array,
  diversified: false,
});

describe('programming a blank simulated tag', () => {
  it('writes the keys, the URL and the SDM settings, and the read verifies', async () => {
    const plan = testPlan();
    const sim = new Ntag424Sim({ random: countingRandom() });
    const send = sendOf(sim);
    const url = parseSunUrl(await programTag(send, new RelayServer(plan)));
    expect(url).toMatchObject({ host: 'passbook.mobile', slug: plan.slug });
    expect(sim.tag.keys.map(bytesToHex)).toEqual(plan.keys.map(bytesToHex));
    expect(sim.tag.versions).toEqual([3, 3, 3, 3, 3]);

    const first = await verifySun(
      keyset(plan.keys),
      (url as { p: string }).p,
      (url as { m: string }).m,
    );
    expect(first).toEqual({ ok: true, read: { uid: bytesToHex(sim.tag.uid), counter: 1 } });
    const again = parseSunUrl(await readUrl(send)) as { p: string; m: string };
    expect(await verifySun(keyset(plan.keys), again.p, again.m)).toMatchObject({
      ok: true,
      read: { counter: 2 },
    });
    const wrong = await verifySun(
      { ...keyset(plan.keys), fileKey: plan.keys[3] as Uint8Array },
      again.p,
      again.m,
    );
    expect(wrong).toEqual({ ok: false, error: 'SUN_MAC_INVALID' });
  });

  it('leaves file 02 as read free, write by key 0 only, with the layout the verifier expects', async () => {
    const plan = testPlan();
    const sim = new Ntag424Sim();
    const send = sendOf(sim);
    await programTag(send, new RelayServer(plan));
    const session = await authenticate(send, 0, plan.keys[0] as Uint8Array);
    const { apdu, sent } = await getFileSettings(session, 2);
    const settings = await checkResponse(session, sent, await send(apdu));
    // type, option 40, rights 00 E0, size 256, SDM C1, FF 12, PICCData at 36, MAC input = MAC at 71.
    expect(bytesToHex(settings)).toBe(
      '0040' + '00e0' + '000100' + 'c1' + 'ff12' + '240000' + '470000' + '470000',
    );
  });

  it('the factory zeros no longer authenticate, the intended key 0 does', async () => {
    const plan = testPlan();
    const sim = new Ntag424Sim();
    await programTag(sendOf(sim), new RelayServer(plan));
    await expect(authenticate(sendOf(sim), 0, ZERO16)).rejects.toMatchObject({
      code: 'NTAG_AUTH_FAILED',
    });
    expect((await authenticate(sendOf(sim), 0, plan.keys[0] as Uint8Array)).keyNo).toBe(0);
  });

  it('refuses a tag whose originality signature does not verify', async () => {
    const sim = new Ntag424Sim();
    sim.signature[3] = (sim.signature[3] as number) ^ 1;
    await expect(programTag(sendOf(sim), new RelayServer(testPlan()))).rejects.toMatchObject({
      code: 'NTAG_UNSUPPORTED',
    });
    expect(sim.tag.versions).toEqual([0, 0, 0, 0, 0]);
  });

  it('answers a part 1 for a key that does not exist with an error, not a challenge', async () => {
    const sim = new Ntag424Sim();
    expect((await sim.transceive(authFirstApdu(5))).slice(-2)).toEqual(
      new Uint8Array([0x91, 0x40]),
    );
  });

  it('the server refuses a read-back that names another host or slug than its template', async () => {
    for (const swap of [
      (u: string) => u.replace('passbook.mobile', 'evil.example'),
      (u: string) => u.replace(testPlan().slug, 'other001'),
    ]) {
      class Tampered extends RelayServer {
        override result(id: string, req: { responses: string[]; url: string }) {
          return super.result(id, { ...req, url: swap(req.url) });
        }
      }
      const sim = new Ntag424Sim({ random: countingRandom() });
      await expect(programTag(sendOf(sim), new Tampered(testPlan()))).rejects.toMatchObject({
        code: 'NTAG_COMMAND_FAILED',
      });
    }
  });
});
