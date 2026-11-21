/** The shape of every cursor list: `items`, and `nextCursor` while more remain. */
export interface PageLike {
  items: ReadonlyArray<unknown>;
  nextCursor?: string | null;
  /** Feeds such as `events.list` always return a cursor; `hasMore: false` ends them. */
  hasMore?: boolean;
}

/**
 * The first page as a promise, and an async iterator over every item.
 * `for await (const pass of pb.passes.list())` walks all pages; `pages()` walks them whole.
 */
export interface PagePromise<P extends PageLike>
  extends Promise<P>,
    AsyncIterable<P['items'][number]> {
  pages(): AsyncGenerator<P, void, undefined>;
}

export function pagePromise<P extends PageLike>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  start: string | undefined,
): PagePromise<P> {
  const first = fetchPage(start);
  async function* pages(): AsyncGenerator<P, void, undefined> {
    let cursor = start;
    let page = await first;
    for (;;) {
      yield page;
      const next = page.nextCursor;
      if (!next || page.hasMore === false || next === cursor) return;
      cursor = next;
      page = await fetchPage(next);
    }
  }
  async function* items(): AsyncGenerator<P['items'][number], void, undefined> {
    for await (const page of pages()) yield* page.items as ReadonlyArray<P['items'][number]>;
  }
  return Object.assign(first, { pages, [Symbol.asyncIterator]: items }) as PagePromise<P>;
}
