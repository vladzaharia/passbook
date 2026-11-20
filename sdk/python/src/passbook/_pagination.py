from __future__ import annotations

from typing import Any, Callable, Generic, Iterator, TypeVar

T = TypeVar("T")


class Page(Generic[T]):
    """One page of a list. Iterating it walks every item on every page; `pages()` walks them whole.

        for pass_ in pb.passes.list(limit=50):
            ...
    """

    def __init__(
        self, result: Any, fetch: Callable[[str], Any], cursor: str | None = None
    ) -> None:
        self.result = result
        self._fetch = fetch
        self._cursor = cursor

    @property
    def items(self) -> list[T]:
        return self.result.items

    @property
    def next_cursor(self) -> str | None:
        return getattr(self.result, "nextCursor", None)

    def pages(self) -> Iterator[Page[T]]:
        page = self
        while True:
            yield page
            nxt = page.next_cursor
            # Feeds such as events.list always return a cursor; hasMore: false ends them.
            if not nxt or getattr(page.result, "hasMore", None) is False or nxt == page._cursor:
                return
            page = Page(page._fetch(nxt), page._fetch, nxt)

    def __iter__(self) -> Iterator[T]:
        for page in self.pages():
            yield from page.items
