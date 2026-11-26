import { ConnectorError } from '../types.ts';
import { type Config, config } from './config.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored row that no longer parses is a permanent config problem, not an internal error. */
function parse(value: unknown): Config {
  const parsed = config.safeParse(value);
  if (!parsed.success) throw new ConnectorError('CONFIG', { permanent: true });
  return parsed.data;
}

/**
 * v1 to v2. A v1 list was a cursor feed whose cursor persists between runs, with the has-more rule
 * unchanged: `listing: 'feed'` and body-cursor pagination. Everything else carries over by name.
 * Anything that is already v2 passes through.
 */
export function migrate(oldVersion: number, stored: unknown): Config {
  if (oldVersion >= 2 || !isObj(stored)) return parse(stored);
  const { list, ...rest } = stored;
  if (!isObj(list)) return parse(rest);
  const {
    cursorParam,
    cursorPointer,
    itemsPointer,
    refPointer,
    hasMorePointer,
    recordPointer,
    deletedPointer,
    path,
  } = list;
  return parse({
    ...rest,
    list: {
      path,
      listing: 'feed',
      recordsPointer: itemsPointer ?? '/items',
      idPointer: refPointer ?? '/id',
      ...(recordPointer === undefined ? {} : { recordPointer }),
      ...(deletedPointer === undefined ? {} : { deletedPointer }),
      pagination: {
        style: 'cursor',
        param: cursorParam ?? 'cursor',
        cursorPointer: cursorPointer ?? '/cursor',
        ...(hasMorePointer === undefined ? {} : { hasMorePointer }),
        from: 'body',
      },
    },
  });
}
