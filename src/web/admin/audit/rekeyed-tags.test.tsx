import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RekeyedTags, rekeyedTags } from './rekeyed-tags.tsx';

describe('rekeyedTags', () => {
  it('lists ids and counts the rest', () => {
    const tags = rekeyedTags('tag_keyset.rekeyed', { count: 25, tagIds: ['a', 'b'] });
    expect(tags).toEqual({ total: 25, ids: ['a', 'b'], more: 23 });
    if (tags) render(<RekeyedTags tags={tags} />);
    expect(screen.getByText('25 tags re-keyed')).toBeInTheDocument();
    expect(screen.getByText('and 23 more')).toBeInTheDocument();
  });
  it('ignores other actions', () => {
    expect(rekeyedTags('tag.assign', { count: 1 })).toBeNull();
  });
});
