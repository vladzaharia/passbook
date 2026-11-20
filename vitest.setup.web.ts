import './src/web/pass-card/barcode-loader.ts';
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';
import { afterAll, afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);
// The default 1 s findBy/waitFor window is shorter than a lazy route chunk takes to transform when
// workerd and jsdom run side by side. A passing test never waits this long.
configure({ asyncUtilTimeout: 10_000 });
// sonner unmounts a dismissed toast on a timer; if the file ends first, the timer fires after jsdom
// is torn down ("window is not defined", an unhandled error that fails the run). Let it finish.
let toastsShown = false;
afterEach(() => {
  toastsShown ||=
    typeof document !== 'undefined' && document.querySelector('[data-sonner-toast]') !== null;
  cleanup();
  sonnerToast.dismiss();
});
afterAll(async () => {
  if (toastsShown) await new Promise((done) => setTimeout(done, 400));
});
