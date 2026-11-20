package passbook

import (
	"context"
	"net/url"
)

// Pager walks a list, one page at a time, fetching the next when the items run out.
//
//	pager := pb.Passes.List(ctx, &passbook.PassesListQuery{})
//	for pager.Next(ctx) {
//		pass := pager.Item()
//	}
//	if err := pager.Err(); err != nil { ... }
type Pager[T any] struct {
	c      *core
	call   call
	param  string
	opts   []RequestOption
	items  []T
	cursor string
	more   bool
	item   T
	err    error
}

type page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"nextCursor"`
	HasMore    *bool   `json:"hasMore"`
}

func newPager[T any](c *core, cl call, param string, opts []RequestOption) *Pager[T] {
	start := cl.query.Get(param)
	return &Pager[T]{c: c, call: cl, param: param, opts: opts, cursor: start, more: true}
}

// Next moves to the next item, fetching a page when needed, and reports whether there is one.
func (p *Pager[T]) Next(ctx context.Context) bool {
	for len(p.items) == 0 {
		if p.err != nil || !p.more {
			return false
		}
		if !p.fetch(ctx) {
			return false
		}
	}
	p.item, p.items = p.items[0], p.items[1:]
	return true
}

func (p *Pager[T]) fetch(ctx context.Context) bool {
	cl := p.call
	cl.query = url.Values{}
	for k, v := range p.call.query {
		cl.query[k] = v
	}
	if p.cursor != "" {
		cl.query.Set(p.param, p.cursor)
	}
	var out page[T]
	if p.err = p.c.do(ctx, cl, &out, p.opts); p.err != nil {
		return false
	}
	p.items = out.Items
	// Feeds such as Events.List always return a cursor; HasMore false ends them.
	next := ""
	if out.NextCursor != nil {
		next = *out.NextCursor
	}
	p.more = next != "" && next != p.cursor && (out.HasMore == nil || *out.HasMore)
	p.cursor = next
	return true
}

// Item is the item Next moved to.
func (p *Pager[T]) Item() T { return p.item }

// Err is the error that ended the walk, if any.
func (p *Pager[T]) Err() error { return p.err }

// All reads every remaining item.
func (p *Pager[T]) All(ctx context.Context) ([]T, error) {
	var out []T
	for p.Next(ctx) {
		out = append(out, p.Item())
	}
	return out, p.Err()
}
