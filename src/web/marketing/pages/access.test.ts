import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(join(process.cwd(), 'marketing/access.html'), 'utf8');
const NOT_SENT = 'Your request was not sent. Email support@passbook.mobile.';

function load() {
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  return import('./access.ts');
}
const set = (id: string, v: string) => {
  (document.getElementById(id) as HTMLInputElement).value = v;
};
function fillValid() {
  set('a-name', 'Alex Morgan');
  set('a-email', 'alex@example.com');
  set('a-org', 'Northside Climbing');
  set('a-for', 'Memberships');
}
const submit = () =>
  document.getElementById('acc-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('access page script', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('turns off native validation and blocks an invalid form', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await load();
    expect((document.getElementById('acc-form') as HTMLFormElement).noValidate).toBe(true);
    submit();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.getElementById('a-name-e')?.textContent).toBe('Enter your name.');
    set('a-name', 'A');
    set('a-email', 'not an email');
    submit();
    expect(document.getElementById('a-email-e')?.textContent).toBe('Enter a work email.');
  });

  it('shows the sent state only on 204', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await load();
    fillValid();
    submit();
    await flush();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/access');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'Alex Morgan',
      email: 'alex@example.com',
      organization: 'Northside Climbing',
      purpose: 'Memberships',
    });
    expect(document.getElementById('acc-ticket')?.classList.contains('sent')).toBe(true);
    expect((document.getElementById('acc-done') as HTMLElement).hidden).toBe(false);
  });

  it.each([
    ['a 503', () => new Response('{}', { status: 503 })],
    ['a 200', () => new Response('{}', { status: 200 })],
    ['a network failure', () => Promise.reject(new TypeError('offline'))],
  ])('says the request was not sent after %s', async (_label, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer()),
    );
    await load();
    fillValid();
    submit();
    await flush();
    const ticket = document.getElementById('acc-ticket');
    const line = document.getElementById('acc-send-e') as HTMLElement;
    expect(ticket?.classList.contains('sent')).toBe(false);
    expect(ticket?.classList.contains('sending')).toBe(false);
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe(NOT_SENT);
    expect(document.getElementById('acc-buddy')?.querySelector('.b-pose-sorry')).not.toBeNull();
  });
});
