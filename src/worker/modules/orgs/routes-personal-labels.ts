import { CursorQuerySchema } from '../../../shared/contracts/common.ts';
import { PersonalOrgLabelsSchema } from '../../../shared/contracts/orgs.ts';
import { personalOrgLabel } from '../../../shared/copy/personal-org.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { personalOrgNames } from './repo-personal.ts';

/** Mount at /api/v1/platform. */
export const platformPersonalLabelsRoutes = createRouter();

register(
  platformPersonalLabelsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/personal-org-labels',
    summary:
      'Names of the personal organizations, which are not listed, for views that show an org by id',
    query: CursorQuerySchema,
    response: PersonalOrgLabelsSchema,
    auth: { platform: 'platform:orgs' },
  },
  async (c) =>
    c.json({
      items: (await personalOrgNames(serviceContext(c).env.DB)).map((r) => ({
        orgId: r.id,
        label: personalOrgLabel(r.name),
      })),
      nextCursor: null,
    }),
);
