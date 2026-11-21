import { z } from 'zod';
import { IdParamSchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  PassImportUndoBodySchema,
  PassImportUndoResultSchema,
} from '../../../shared/contracts/pass-imports.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { svc } from './http.ts';
import { undoImport } from './import-undo.ts';
import { authorityFor } from './routes-import-mappings.ts';

type Router = ReturnType<typeof createRouter>;
const TAG = 'pass-imports';

/** POST /{id}/undo: a session or a key with passes:write, like the commit it undoes. */
export function registerImportUndo(router: Router): void {
  register(
    router,
    TAG,
    {
      method: 'post',
      path: '/{id}/undo',
      summary:
        'Undo an ended import: remove the passes it made and restore the ones it changed, unless edited since',
      params: IdParamSchema,
      query: z.object({ orgId: IdSchema.optional() }),
      body: PassImportUndoBodySchema,
      response: PassImportUndoResultSchema,
    },
    async (c) => {
      const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
      return c.json(await undoImport(svc(c), authority, c.req.valid('param').id));
    },
  );
}
