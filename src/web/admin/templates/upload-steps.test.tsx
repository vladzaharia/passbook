import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../lib/test-utils.tsx';
import { UploadSteps, uploadStepIndex } from './upload-steps.tsx';

describe('UploadSteps', () => {
  it('marks what is done, the running step and what is left', () => {
    render(<UploadSteps step="analyze" failed={false} />);
    const list = screen.getByRole('list', { name: 'Import progress' });
    const items = Array.from(list.querySelectorAll('li'));
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('Waiting to start (done)');
    expect(items[1]).toHaveTextContent('Opening the package (done)');
    expect(items[2]).toHaveTextContent('Checking files and images (in progress)');
    expect(items[3]).not.toHaveTextContent('(');
    expect(items[4]).not.toHaveTextContent('(');
  });

  it('says which step failed', () => {
    render(<UploadSteps step="dry-run" failed />);
    expect(screen.getByText(/Building a sample pass/)).toHaveTextContent('(failed)');
  });

  it('counts a step it does not know as the first', () => {
    expect(uploadStepIndex('unzip')).toBe(0);
    expect(uploadStepIndex(null)).toBe(0);
    expect(uploadStepIndex('done')).toBe(4);
  });
});
