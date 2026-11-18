import { describe, expect, it } from 'vitest';
import { boundaryImports, testOnlyImports, tooLong } from './check-sizes.ts';

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

  it('limits who may import the webhook raw-write modules', () => {
    const text = "import { finishStmt } from './repo-delivery-state.ts';";
    const dir = 'src/worker/modules/webhooks';
    expect(boundaryImports(`${dir}/routes.ts`, text)).toEqual([
      `${dir}/routes.ts may not import ${dir}/repo-delivery-state.ts`,
    ]);
    expect(boundaryImports(`${dir}/deliver.ts`, text)).toEqual([]);
    expect(boundaryImports(`${dir}/x.test.ts`, text)).toEqual([]);
    expect(
      boundaryImports(`${dir}/dispatch.ts`, "import { purge } from './repo-retention.ts';"),
    ).toHaveLength(1);
    expect(
      boundaryImports(`${dir}/jobs.ts`, "import { purge } from './repo-retention.ts';"),
    ).toEqual([]);
  });
});
