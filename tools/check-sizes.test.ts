import { describe, expect, it } from 'vitest';
import { testOnlyImports, tooLong } from './check-sizes.ts';

describe('check-sizes', () => {
  it('flags long source files but not tests or generated code', () => {
    const long = `${'x\n'.repeat(400)}`;
    expect(tooLong('src/a.ts', long)).toMatch(/400 lines/);
    expect(tooLong('src/a.test.ts', long)).toBeNull();
    expect(tooLong('src/generated/a.ts', long)).toBeNull();
    expect(tooLong('src/a.ts', 'x\n'.repeat(330))).toBeNull();
  });

  it('flags production imports of test-only modules', () => {
    const text = "import { kit } from './test-kit.ts';\nimport { a } from './service.ts';";
    expect(testOnlyImports('src/worker/modules/x/routes.ts', text)).toEqual([
      'src/worker/modules/x/routes.ts imports test-only module ./test-kit.ts',
    ]);
    expect(testOnlyImports('src/worker/modules/x/routes.test.ts', text)).toEqual([]);
    expect(testOnlyImports('src/worker/modules/x/test-support.ts', text)).toEqual([]);
  });
});
