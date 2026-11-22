import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import '../../lib/test-utils.tsx';
import { type TAG_SCENARIOS, TagVisual } from '../visual-tags.tsx';
import { flagText, noneLine } from './tag-lines.ts';

const show = (scenario: (typeof TAG_SCENARIOS)[number]) =>
  render(<TagVisual scenario={scenario} />);

describe('the assign card', () => {
  it('step 1 words follow the reader', () => {
    show('assign-tag-android').unmount();
    show('assign-tag-iphone');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SCAN_TAG_COPY.tag.ios);
    expect(screen.getByRole('button', { name: SCAN_TAG_COPY.tag.readButton })).toBeTruthy();
  });
  it('USB asks for a tap on the reader', () => {
    show('assign-tag-usb');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SCAN_TAG_COPY.tag.usb);
  });
  it('Chrome asks for a tap: Allow NFC is in the dock', () => {
    show('assign-tag-web');
    expect(screen.getByRole('button', { name: SCAN_TAG_COPY.tag.allowNfc })).toBeTruthy();
  });
  it('marks the current step', () => {
    show('assign-pass');
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain(
      SCAN_TAG_COPY.step.pass,
    );
    expect(screen.getByTestId('scan-tag-chip').textContent).toContain('Tag ends 7 F 3 A');
  });
  it('shows a banner and keeps the step', () => {
    show('assign-pass-banner');
    expect(screen.getByTestId('scan-assign-banner').textContent).toContain('Voided');
  });
  it('an ambiguous card offers Look up by name, and it opens the sheet', () => {
    const lookUp = vi.fn();
    render(<TagVisual scenario="assign-pass-ambiguous" onLookUp={lookUp} />);
    const banner = screen.getByTestId('scan-assign-banner');
    expect(banner.textContent).toContain('More than one pass');
    fireEvent.click(within(banner).getByRole('button', { name: 'Look up' }));
    expect(lookUp).toHaveBeenCalledTimes(1);
  });
  it('the ambiguous screen has one Look up: the banner, not the dock', () => {
    show('assign-pass-ambiguous');
    expect(screen.getAllByRole('button', { name: 'Look up' })).toHaveLength(1);
    cleanup();
    show('assign-pass');
    expect(screen.getAllByRole('button', { name: 'Look up' })).toHaveLength(1);
  });
  it('a pass picked by id asks a Desk for the PIN on the pass step', () => {
    show('assign-pass-pin');
    expect(screen.getByTestId('scan-approval')).toBeTruthy();
    expect(screen.queryByTestId('scan-assign-info')).toBeNull();
  });
  it('a refused person scope says why, on this pass', () => {
    show('assign-confirm-person-off');
    expect(screen.getByTestId('scan-assign-note').textContent).toContain(
      "can't assign to a person",
    );
    expect((screen.getByRole('radio', { name: /This pass/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });
  it('the done card shows the holder photo', () => {
    show('assign-done-photo');
    expect(document.querySelector('.scan-assign-photo')).toBeTruthy();
  });
  it('other banners have no Look up button', () => {
    show('assign-pass-banner');
    expect(within(screen.getByTestId('scan-assign-banner')).queryByRole('button')).toBeNull();
  });
  it('confirm shows the holder photo, and initials when it fails to load', () => {
    show('assign-confirm-photo');
    const photo = document.querySelector<HTMLImageElement>('.scan-assign-photo');
    expect(photo?.getAttribute('src')).toContain('data:image/svg+xml');
    fireEvent.error(photo as HTMLImageElement);
    expect(document.querySelector('.scan-assign-photo')).toBeNull();
    expect(document.querySelector('.scan-assign-initials')).toBeTruthy();
  });
  it('confirm without a photo shows initials', () => {
    show('assign-confirm');
    expect(document.querySelector('.scan-assign-photo')).toBeNull();
    expect(document.querySelector('.scan-assign-initials')).toBeTruthy();
  });
  it('the tag prop sits beside the buddy once a tag is read, and the done card plays link', () => {
    show('assign-done');
    expect(document.querySelector('.wl-buddy-prop .scan-tag-prop')).toBeTruthy();
    expect(document.querySelector('.wl-buddy')?.getAttribute('data-beat')).toBe('link');
    expect(document.querySelector('.scan-tag-chain')).toBeTruthy();
  });
  it('no tag read, no prop', () => {
    show('assign-tag-android');
    expect(document.querySelector('.scan-tag-prop')).toBeNull();
  });
  it('confirm offers the person only with an account, and the Works with label', () => {
    show('assign-confirm');
    expect(screen.getByText(SCAN_TAG_COPY.worksWith.label)).toBeTruthy();
    expect(screen.getByLabelText(/All of Maya Okafor's passes/)).toBeTruthy();
    expect(screen.getByTestId('scan-assign-info').textContent).toBe(SCAN_TAG_COPY.confirm.basic);
  });
  it("another holder's tag: warning, and a desk is asked to Ask a manager", () => {
    show('assign-confirm-other');
    expect(screen.getByTestId('scan-assign-info').textContent).toContain("Leo Park's Pool day");
    expect(screen.getByRole('button', { name: 'Ask a manager' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: SCAN_TAG_COPY.confirm.move })).toBeNull();
  });
  it('moving your own tag says Move tag', () => {
    show('assign-confirm-person');
    expect(screen.getByRole('button', { name: SCAN_TAG_COPY.confirm.move })).toBeTruthy();
  });
  it('done offers Assign another and Done, with Undo in the strip', () => {
    show('assign-done');
    expect(screen.getByRole('button', { name: SCAN_TAG_COPY.dock.assignAnother })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SCAN_TAG_COPY.ok.assigned);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });
  it.each([
    ['assign-lost', SCAN_TAG_COPY.err.lost.headline],
    ['assign-secure', SCAN_TAG_COPY.err.secureNeeded.headline],
    ['assign-already', SCAN_TAG_COPY.err.alreadyHere.headline],
    ['assign-offline', SCAN_TAG_COPY.err.notAssigned.headline],
    ['assign-too-many', SCAN_TAG_COPY.err.tooMany.headline],
  ] as const)('%s is %s', (scenario, headline) => {
    show(scenario);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(headline);
  });
  it('a pass that was reassigned offers Start again and Done', () => {
    show('assign-holder-changed');
    expect(screen.getByText(SCAN_TAG_COPY.err.holderChanged.sub)).toBeTruthy();
    expect(screen.getByRole('button', { name: SCAN_TAG_COPY.dock.startAgain })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
  it('too many tries keeps Cancel and a Try again that waits for the countdown', () => {
    vi.useFakeTimers();
    try {
      show('assign-too-many');
      const again = screen.getByRole('button', { name: SCAN_TAG_COPY.dock.tryAgain });
      expect((again as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(21_000);
      });
      expect((again as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText(SCAN_TAG_COPY.err.tooMany.ready)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
  it('a policy refusal names the next step and offers only Done', () => {
    show('assign-secure');
    expect(screen.getByText(/Ask an admin/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: SCAN_TAG_COPY.dock.tryAnother })).toBeNull();
  });
  it('the web hint rides an unreadable tag', () => {
    show('assign-unreadable-web');
    expect(screen.getByText(new RegExp(SCAN_TAG_COPY.err.unreadableWeb))).toBeTruthy();
  });
  it('a lost tag has no Try another tag; an offline one offers Try again and Cancel', () => {
    show('assign-lost');
    expect(screen.queryByRole('button', { name: SCAN_TAG_COPY.dock.tryAnother })).toBeNull();
  });
  it('a request shows who asked, the read-only choice and the pass, and no Assign another', () => {
    show('request-card');
    expect(screen.getByText('From Ana R. in the console')).toBeTruthy();
    expect(screen.getByTestId('scan-assign-opens').textContent).toContain(
      "all of Maya Okafor's passes",
    );
    expect(screen.queryByRole('button', { name: SCAN_TAG_COPY.dock.assignAnother })).toBeNull();
    expect(screen.getByTestId('scan-assign-chip').textContent).toMatch(/Tag for Maya/);
  });
  it('a finished request names the admin', () => {
    show('request-done');
    expect(screen.getByText('For Ana R.')).toBeTruthy();
  });
  it('a request that waits on the console shows it', () => {
    show('request-waiting');
    expect(screen.getByText(SCAN_TAG_COPY.request.waitingConsole)).toBeTruthy();
  });
  it('the waiting chip and the strip', () => {
    show('request-chip-waiting');
    expect(screen.getByRole('button', { name: SCAN_TAG_COPY.chip.request })).toBeTruthy();
  });
  it('the strip has Open and Later', () => {
    show('request-strip');
    const strip = screen.getByTestId('scan-request-strip');
    expect(within(strip).getByRole('button', { name: SCAN_TAG_COPY.request.open })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: SCAN_TAG_COPY.request.later })).toBeTruthy();
  });
});

describe('tags at the door', () => {
  it('a pass the tag opens shows the plain flag', () => {
    show('door-tag-ok');
    expect(screen.getByTestId('scan-tag-flag').textContent).toBe(SCAN_TAG_COPY.door.flag);
  });
  it("a person's several passes: the flag says which, and Why this pass lists them", () => {
    show('door-tag-of-many');
    const flag = screen.getByTestId('scan-tag-flag');
    expect(flag.textContent).toBe("Tag · 1 of Anna's 3 passes");
    fireEvent.click(flag);
    const rows = screen
      .getAllByRole('listitem')
      .filter((li) => li.className.includes('scan-tag-pass'));
    expect(rows.map((r) => r.textContent)).toEqual([
      'HQ accessUsedLets in',
      'GymAlso lets in',
      `Parking${SCAN_TAG_COPY.door.notHere}`,
    ]);
  });
  it('none lets them in: the line, and Why not? opens the reasons', () => {
    show('door-tag-none');
    expect(screen.getByTestId('scan-tag-none').textContent).toContain(
      "None of Anna's 3 passes lets them in here.",
    );
    fireEvent.click(screen.getByRole('button', { name: SCAN_TAG_COPY.door.whyNot }));
    expect(screen.getByTestId('scan-tag-passes')).toBeTruthy();
  });
  it('an unknown tag has its own words and an Assign tag button', () => {
    show('door-unknown');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      SCAN_TAG_COPY.door.unknownTag.headline,
    );
    expect(screen.getByTestId('scan-assign-unknown')).toBeTruthy();
  });
  it('a desk result offers Add tag', () => {
    show('door-add-tag');
    expect(screen.getByTestId('scan-add-tag').textContent).toBe('Add tag');
  });
  it('offline says Tag needs a connection', () => {
    show('door-offline');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      SCAN_TAG_COPY.needsConnection,
    );
  });
  it('an iPhone door has Tap to read', () => {
    const { container } = show('door-tap-to-read');
    expect(within(container).getByTestId('scan-tap-to-read').textContent).toBe('Tap to read');
  });
  it('flag and none lines', () => {
    expect(
      flagText({ hint: 'AAAA', assurance: 'basic', scope: 'user', count: 1 }, 'Maya Okafor'),
    ).toBe('Tag');
    expect(noneLine({ hint: 'AAAA', assurance: 'basic', scope: 'pass' }, 'Maya')).toBeNull();
    expect(vi.isMockFunction(flagText)).toBe(false);
  });
});

/** Copy that the scanner does not show in v1, or that is picked by a dynamic key. */
const NOT_YET = new Set([
  'lendingTo',
  'door.basicTag',
  'ok.lent',
  'ok.lentSub',
  'tag.cancelled',
  'tag.noRead',
  'strip.cancelled',
  'strip.timedOut',
  'strip.requestCancelled',
  'strip.adminCancelled',
  'strip.requestTimedOut',
  'strip.assigned',
  'settings.assign.off',
  'settings.assign.desk',
  'settings.assign.manager',
  'pass.cantAssign',
  'err.tooMany.ready',
  'dock.startAgain',
  'dock.tryAgain',
  'err.holderChanged.headline',
  'err.holderChanged.sub',
  'err.secureNeededDoor.headline',
  'err.secureNeededDoor.sub',
  'approval',
  'worksWith.personSub',
  'door.noneAccepted.headline',
  'door.noneAccepted.sub',
  'door.noPass.headline',
  'door.noPass.sub',
  'door.belongsTo',
  'door.letsIn',
  'request.waitingConsole',
]);

const leaves = (value: unknown, path = ''): string[] =>
  typeof value === 'string' || Array.isArray(value)
    ? [path]
    : Object.entries(value as object).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.tsx?$/.test(n) && !/\.test(\.|-support)/.test(n)
        ? [p]
        : [];
  });

describe('copy coverage', () => {
  const source = walk(join(process.cwd(), 'src/web/scan'))
    .filter((p) => !p.includes('visual-'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  it('every scanner tag line is used by a screen, or is listed as not shown yet', () => {
    const unused = leaves(SCAN_TAG_COPY).filter((path) => {
      if (NOT_YET.has(path)) return false;
      const tail = path.split('.').slice(-2).join('\\.');
      const key = new RegExp(`\\.${tail}\\b`);
      return !key.test(source) && !new RegExp(`\\.${path.split('.').at(-1)}\\b`).test(source);
    });
    expect(unused).toEqual([]);
  });
  it('the exceptions are real keys', () => {
    const all = new Set(leaves(SCAN_TAG_COPY));
    const nested = (p: string) => [...all].some((l) => l === p || l.startsWith(`${p}.`));
    expect([...NOT_YET].filter((p) => !nested(p))).toEqual([]);
  });
});

describe('reduced motion', () => {
  it('every animation in the tag styles sits inside a no-preference block, so reduced motion gets the still drawing', () => {
    const files = ['assign.css', 'tag-chrome.css'].map((f) =>
      readFileSync(join(process.cwd(), 'src/web/scan/assign', f), 'utf8'),
    );
    const css = files.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*\n\}\n?$/,
      '',
    );
    expect(outside).not.toMatch(/animation|@keyframes|transition/);
    expect(css).toMatch(/prefers-reduced-motion: no-preference/);
  });
});
