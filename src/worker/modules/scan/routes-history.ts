import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  HistoryPageSchema,
  HistoryQuerySchema,
  PassNoteRequestSchema,
  PassNoteSchema,
  PassNotesSchema,
} from '../../../shared/contracts/scan-history.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { scanActorOf } from './guard.ts';
import { passHistory } from './history-pass.ts';
import { addNote, notesFor } from './notes.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

const PassParam = z.object({ passId: z.string().min(1).max(64) });

/** A person's history and staff notes. Register on the guarded scanner router, which admits the roles. */
export function registerScanHistoryRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'scan',
    {
      method: 'get',
      path: '/passes/{passId}/history',
      summary: "A person's last 30 days",
      params: PassParam,
      query: HistoryQuerySchema,
      response: HistoryPageSchema,
    },
    async (c) =>
      c.json(
        await passHistory(
          serviceContext(c),
          scanActorOf(c),
          c.req.valid('param').passId,
          c.req.valid('query'),
        ),
      ),
  );
  register(
    router,
    'scan',
    {
      method: 'get',
      path: '/passes/{passId}/notes',
      summary: "A person's staff notes",
      params: PassParam,
      response: PassNotesSchema,
    },
    async (c) =>
      c.json(
        await notesFor(
          serviceContext(c),
          cloneObservedScanActor(scanActorOf(c)),
          c.req.valid('param').passId,
        ),
      ),
  );
  register(
    router,
    'scan',
    {
      method: 'post',
      path: '/passes/{passId}/notes',
      summary: 'Add a staff note',
      params: PassParam,
      body: PassNoteRequestSchema,
      response: PassNoteSchema,
    },
    async (c) =>
      c.json(
        await addNote(
          serviceContext(c),
          cloneObservedScanActor(scanActorOf(c)),
          c.req.valid('param').passId,
          c.req.valid('json'),
        ),
      ),
  );
}
