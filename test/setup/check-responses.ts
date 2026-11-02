// Every JSON response a route sends is parsed against its declared schema, so a body the
// contract would reject fails the worker test instead of the page.
import { enableResponseChecks } from '../../src/worker/platform/openapi.ts';

enableResponseChecks();
