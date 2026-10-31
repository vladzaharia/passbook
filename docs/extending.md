# Extending

Everything below is a folder plus `npm run gen`. Registries in `src/generated/*` are generated;
never edit them or a shared index.

## Add a template package

A template is a folder with a native `pass.json`, images and a `wallet.template.json` manifest.

    templates/my-card/
      pass.json                 Apple pass.json with placeholder values
      wallet.template.json      inputs, bindings, display (below)
      icon.png icon@2x.png icon@3x.png   required; logo, strip, thumbnail, ... as the style needs
      en.lproj/pass.strings     optional
      tooling.json              optional Pass Designer file, never signed into a pass

Minimal `wallet.template.json`:

```json
{
  "schema": 1,
  "name": "My card",
  "inputs": {
    "type": "object",
    "required": ["holder"],
    "properties": {
      "holder": { "type": "string", "x-label": "Name", "minLength": 1, "maxLength": 80 }
    }
  },
  "sample": { "holder": "Alex Morgan" },
  "bindings": [
    { "to": { "field": "holder" }, "value": "{{holder}}" },
    { "to": { "barcode": "*", "prop": "message" }, "value": "{{holder}}" }
  ],
  "display": { "title": "{{holder}}", "search": ["holder"] }
}
```

- `inputs` is JSON Schema. `x-label`, `x-group`, `x-order`, `x-widget`, `x-search` drive the forms.
- `bindings` write input values into `pass.json` by field key, barcode, action or JSON pointer.
  Values are `{{input}}` expressions; `omitIfEmpty` and `remove` drop empty parts.
- `behaviors` (optional): `[{ "use": "venue-locations", "version": 1, "config": { … } }]`.
- Start from a copy of `templates/starter-generic`. See `templates/henrys-blue` for lookups
  and behaviors.

Build and check:

    npm run gen        # validates the package, bakes it into src/generated and public/templates
    npm run check

Baked templates are read-only in the admin console; clone one to edit it.

**Upload instead of bake.** Admins can upload the same folder as a zip (up to 15 MB) from
Templates. Extra limits for uploads: `pass.json` and the manifest are at most 64 KiB each, PNGs at
most 4096 px per side, no `pattern` or `$ref` in the input schema, and only behaviors that exist in
the registry. The import report lists every issue by path.

## Add a behavior

A behavior is trusted code that edits a pass after bindings run (for example adding locations).

1. `src/passkit/behaviors/<id>/index.ts` with `export default` of a `BehaviorPlugin`:

   ```ts
   const plugin: BehaviorPlugin<Config> = {
     id: 'my-behavior',
     version: 1,
     configSchema: { type: 'object', additionalProperties: false, properties: { … } },
     apply(pass, input, config, ctx) { /* mutate pass */ },
   };
   export default plugin;
   ```

2. Tests beside it (`index.test.ts`). `venue-locations` is the model.
3. `npm run gen`. Templates reference it with `behaviors: [{ "use": "my-behavior", … }]`.

Bump `version` when `configSchema` changes in a way that breaks stored configs.

## Add a connector

A connector pulls records from an upstream system and maps them to pass inputs.

1. `src/worker/connectors/<type>/index.ts` with `export default` of a `ConnectorDefinition`
   (`src/worker/connectors/types.ts`):
   - `type`, `version`, `displayName`
   - `capabilities`: `poll`, `delta`, `webhook`, `import`, `snapshot`
   - `configSchema` (zod, non-secret; also drives the admin form), optional `secretSchema`
     (write-only, never returned)
   - `outputFields`: the fields templates can bind to
   - `defaults`: `intervalSeconds`, `maxConcurrency`, `requestsPerMinute`, `timeoutMs`
   - `urls(config)`: every URL it will fetch, checked against the SSRF rules when saved
   - `fetchRecord(ctx, ref)`: required; returns `ok`, `not_modified` or `not_found`
   - optional `test`, `listChanges` (cursor paging), `verifyWebhook`, `importRecords`
2. Network only through `ctx.fetch` (HTTPS, public hosts, no redirects, size and time caps).
   Never read the Worker env or log secrets.
3. Failures: throw `ConnectorError('AUTH' | 'FORBIDDEN' | 'RATE_LIMITED' | 'UPSTREAM' | 'TIMEOUT' |
   'INVALID_PAYLOAD' | 'CONFIG')`. `AUTH` and `TIMEOUT` mark the connection unhealthy and never
   change passes.
4. Tests beside it. `demo` (deterministic fake upstream) and `http-json` are the models.
5. `npm run gen`, then create a connection in the admin console and bind passes to it.
