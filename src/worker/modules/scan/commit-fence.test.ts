import { beforeAll, describe } from 'vitest';
import { registerCommitFenceActions } from './repo-commit-fence-action-test-fixtures.ts';
import { registerCommitFenceControls } from './repo-commit-fence-controls-test-fixtures.ts';
import { registerCommitFenceRefusals } from './repo-commit-fence-refusals-test-fixtures.ts';
import { setupCommitFenceFixture } from './repo-commit-fence-test-fixtures.ts';
import { registerCommitFenceUndo } from './repo-commit-fence-undo-test-fixtures.ts';

beforeAll(setupCommitFenceFixture);

describe('scanner commit authority', () => {
  registerCommitFenceActions();
  registerCommitFenceRefusals();
});

describe('undo commit authority', () => {
  registerCommitFenceUndo();
});

describe('unchanged commit authority', () => {
  registerCommitFenceControls();
});
