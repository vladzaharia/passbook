import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

expect.extend(axeMatchers);
// The default 1 s findBy/waitFor window is shorter than a lazy route chunk takes to transform when
// workerd and jsdom run side by side. A passing test never waits this long.
configure({ asyncUtilTimeout: 10_000 });
afterEach(() => cleanup());
