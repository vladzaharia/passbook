import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { preloadArt } from '../../ui/index.ts';
import { UploadDrop } from './upload-drop.tsx';

const zone = () => document.querySelector('.wl-drop') as HTMLElement;
const mood = () =>
  document.querySelector('[data-buddy] [data-part="w"]')?.getAttribute('data-mood');

beforeAll(async () => {
  await preloadArt();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('upload drop buddy', () => {
  it('sits on the zone, decorative, and reaches up for a hovering file', () => {
    render(<UploadDrop label="Drop a template package" file={undefined} onFile={() => {}} />);
    const buddy = document.querySelector('.wl-drop > [data-buddy]');
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    // One active art (B13): the template art is the buddy's prop, nothing else enters.
    expect(document.querySelectorAll('.wl-drop svg.wl-art')).toHaveLength(2);
    expect(buddy?.querySelector('.wl-buddy-prop [data-art="template"]')).not.toBeNull();
    expect(mood()).toBeNull();
    fireEvent.dragOver(zone());
    expect(zone()).toHaveAttribute('data-drag');
    expect(mood()).toBe('curious');
    fireEvent.dragLeave(zone());
    expect(mood()).toBeNull();
  });

  it('catches a file without cheering (happy waits for the result card) and sighs at a refusal', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }) as MediaQueryList);
    const file = new File(['zip'], 'card.zip', { type: 'application/zip' });
    const { rerender } = render(<UploadDrop label="Drop" file={undefined} onFile={() => {}} />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    // A squash as it catches it (the beat scene runs), still neutral (B4a).
    expect(document.querySelector('[data-buddy]')).toHaveAttribute('data-run');
    rerender(<UploadDrop label="Drop" file={file} onFile={() => {}} />);
    expect(mood()).toBeNull();
    rerender(<UploadDrop label="Drop" file={file} onFile={() => {}} rejected={1} />);
    expect(mood()).toBe('sad');
    rerender(<UploadDrop label="Drop" file={file} onFile={() => {}} failed={1} landed={2} />);
    expect(mood()).toBe('sad');
  });

  it('riffles its passes only once an import has run for 600 ms, and stops when it ends', () => {
    vi.useFakeTimers();
    const file = new File(['zip'], 'card.zip', { type: 'application/zip' });
    const { rerender } = render(
      <UploadDrop label="Drop" file={file} onFile={() => {}} disabled landed={1} />,
    );
    act(() => vi.advanceTimersByTime(590));
    expect(zone()).not.toHaveAttribute('data-riffle');
    act(() => vi.advanceTimersByTime(20));
    expect(zone()).toHaveAttribute('data-riffle');
    rerender(<UploadDrop label="Drop" file={file} onFile={() => {}} disabled landed={4} />);
    expect(zone()).not.toHaveAttribute('data-riffle');
  });

  it('a quick import never riffles', () => {
    vi.useFakeTimers();
    const file = new File(['zip'], 'card.zip', { type: 'application/zip' });
    const { rerender } = render(
      <UploadDrop label="Drop" file={file} onFile={() => {}} disabled landed={0} />,
    );
    act(() => vi.advanceTimersByTime(300));
    rerender(<UploadDrop label="Drop" file={file} onFile={() => {}} disabled landed={4} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(zone()).not.toHaveAttribute('data-riffle');
  });

  it('leaves the buddy to the done card when compact', () => {
    render(<UploadDrop label="Done" file={undefined} onFile={() => {}} compact done landed={4} />);
    expect(document.querySelector('[data-buddy]')).toBeNull();
    expect(document.querySelector('.wl-drop [data-art="template"]')).not.toBeNull();
  });
});
