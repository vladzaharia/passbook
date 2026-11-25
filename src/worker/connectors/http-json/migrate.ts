import { type Config, config } from './config.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * v1 to v2. A v1 list was a cursor feed whose cursor persists between runs, with the has-more rule
 * unchanged: `listing: 'feed'` and body-cursor pagination. Everything else carries over by name.
 * Anything that is already v2 passes through.
 */
export function migrate(oldVersion: number, stored: unknown): Config {
  if (oldVersion >= 2 || !isObj(stored)) return config.parse(stored);
  const { list, ...rest } = stored;
  if (!isObj(list)) return config.parse(rest);
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
  return config.parse({
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
