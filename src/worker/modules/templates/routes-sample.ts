import { IdParamSchema } from '../../../shared/contracts/index.ts';
import { sampleCsv } from '../../../shared/issuing/sample.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { TemplateScopeQuerySchema } from './route-scope.ts';
import { detail } from './service.ts';

type Router = ReturnType<typeof createRouter>;

/** GET /{id}/sample.csv: the file an import of this template maps in full and checks without errors. */
export function registerTemplateSample(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/sample.csv',
      summary: 'A sample import file: the template field labels and one valid row',
      auth: { scope: 'templates:read' },
      params: IdParamSchema,
      query: TemplateScopeQuerySchema,
    },
    async (c) => {
      const { inputSchema } = await detail(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('query').orgId,
      );
      return new Response(sampleCsv(inputSchema), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="sample-import.csv"',
          'cache-control': 'no-store',
        },
      });
    },
  );
}
