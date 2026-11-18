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

- `inputs` is JSON Schema. `x-label`, `x-group`, `x-order`, `x-widget`, `x-search` drive the forms. `x-hidden: true` keeps an input valid for stored passes but out of the form.
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

## Add stamps to a card

A top-level `stamps` block turns a strip card (store card, coupon, event ticket) into a stamp card.
`templates/starter-stamp-card` is the reference package.

```json
"stamps": {
  "input": "stamps",
  "goal": 10,
  "art": { "filled": "stamps/filled.png", "empty": "stamps/empty.png" },
  "tilt": true
}
```

- `goal` is 3 to 20. `input` is an integer input from 0; set its `maximum` to `2 * goal - 1` (a full
  card plus the carry-over). `art.reward` and `art.rewardEarned` are optional.
- Art is square PNG, 128 to 1000 px (256 or more recommended), the stamp in the middle two thirds.
  The package's own `strip@2x.png` and `strip@3x.png` (750 × 288, 1125 × 432) are the background;
  without them the pass colour shows through.
- Saving a version draws one strip pair per count into `stamps/strips/<n>/`; a save whose goal,
  tilt, art and background match an earlier version carries that version's strips. Do not ship the
  folder. A pass ships the pair for its count as `strip@2x.png`.
- Expressions and conditions read `pass.stamps.goal|card|left|ready|extra`. Put the `changeMessage` on
  a field whose value flips once, with `"when": { "input": "pass.stamps.ready", "eq": true }`.
- `POST /api/v1/passes/{id}/stamps` with `{ "action": "add", "count": 1 }` or
  `{ "action": "redeem" }` adds stamps or takes the goal off. A full card refuses an add
  (`STAMPS_CARD_FULL`); a card short of the goal refuses a redeem (`STAMPS_NO_REWARD`).
- At the scanner, an `add` on the count stamps and a `take` redeems (the goal comes off; extra stamps
  carry over). A `take` on the count must set `amount` to the goal, and the designer keeps it in step
  when the goal changes. A full card refuses an add as `card_full`. Only the stamp that fills the card
  alerts the holder, past the daily push limit too. The scanner draws up to 16 stamps; a longer goal
  shows as a bar.
- Changing the goal of a template with live passes: `GET /api/v1/templates/{id}/stamps-impact?goal=`
  says who is affected. A lowering alerts the cards it makes ready; a raise keeps ready cards ready
  when the version sets `stamps.keepReady`. A reissue, `PATCH` or transfer that would leave a card
  above the new version's input `maximum` fails for that card with `STAMPS_ABOVE_MAX` (the card
  stays on its version; a bulk reissue reports it as `aboveMax`). Stamps are never dropped.

## Add a wallets block

An optional top-level `wallets` block holds what Apple's model cannot say, for Google and Samsung
(`docs/design/wallet-providers/architecture.md`, 2.3). Without it nothing changes. Apple output,
the build key and the Apple release hash ignore it, so editing it never reissues a pass.

```json
"wallets": {
  "schema": 1,
  "roles": { "points": { "field": "points" }, "tier": { "value": "{{level}}" }, "balance": false },
  "required": ["barcode.format"],
  "google": { "type": "loyalty", "classKey": "{{event_code}}", "omit": ["backFields.terms"],
              "images": { "logo": "wallets/google/logo.png" } },
  "samsung": { "type": "loyalty", "subType": "others", "images": { "main": "wallets/samsung/main.png" } }
}
```

- `roles`: a role is `{ "field": key }`, `{ "value": expression }` (the manifest expression
  language) or `false` (absent on purpose). Names: `title`, `eventStart`, `memberId`, `tier`,
  `points`, `balance`, `validUntil` and the rest of the table in the design (2.2).
- `required`: capability ids that must be native on a wallet, else it is blocked (`type`,
  `barcode.format`, `role.points`, `image.strip`; the full list is `CAPABILITY_IDS` in
  `src/passkit/wallets/vocab.ts`). `<wallet>.omit`: field paths (`backFields.terms`), field keys or
  capability ids left out on purpose. `<wallet>.type`: a type, or `off` to skip that wallet.
- `<wallet>.images`: slot to `wallets/<google|samsung>/<name>.png`. Slots: Google `logo`, `hero`,
  `thumbnail`; Samsung `logo`, `main`, `background`. The files are kept in the
  version and never signed into a pass. Other names under `wallets/` are refused.
- Unknown keys are errors. Issues are `WALLETS_*`, plus `WALLET_ART_PNG` for a file that is not a
  PNG (`src/passkit/template/wallets/`).

## Google and Samsung wallets

Both compile from the same pass; the matrix of what each carries is
`docs/design/wallet-providers/capabilities.md` (generated). The fidelity report lists what a
wallet cannot show (`FidelityReportSchema`, `src/shared/contracts/wallet-fidelity.ts`).

- Google types: `generic`, `event`, `loyalty`, `gift`, `offer`. Chosen from the pass style
  (eventTicket to event, coupon to offer, storeCard to loyalty or gift), else `generic`; set
  `wallets.google.type` to force one. A type whose roles are missing falls back to generic and says so.
- Samsung types: `loyalty`, `ticket`, `coupon`. Anything without a native attribute (gift cards,
  boarding passes, extra fields) goes to the notice text and is reported.
- Roles: `title`, `eventName`, `memberId`, `points`, `balance`, `validUntil` and the rest of
  `WALLET_ROLES`. Set one with `wallets.roles` (field, value or `false`); otherwise semantics and
  style defaults fill it.
- Art slots: Google `logo`, `hero`, `thumbnail`; Samsung `logo`, `main`, `background`, as
  `wallets/<target>/<name>.png`. Only template art with a public URL is sent; a per-pass image never is.
- Omit forms (`wallets.<target>.omit`): a capability id (`barcode.altText`), a field path
  (`backFields.terms`) or a bare field key. Omitting approves that loss; unlisted omissions need
  release approval. Identity values (barcode message, member id, ticket number) are never cut: too
  long blocks the pass on that wallet.

## Add scan actions

A top-level `scan.actions` array (1 to 6) lists what staff can do with the pass at a scanner.
`starter-stamp-card` is the reference. Saving a version validates it (`SCAN_*`
issues, `src/passkit/template/scan-actions.ts`).

- `id` (lower case, up to 32), `label` (up to 24, unique) and `kind`: `check_in`, `add`, `take`,
  `set` or `use_up`. Other keys: `input`, `amount`, `value`, `repeat` (`once`, `daily`, `cooldown`,
  `always`) with `cooldownMinutes`, `minRole` (`door`, `desk`, `manager`), `confirm`,
  `confirmAbove`, `allowAgain`, `rewardLabel`, `notify`, `allowOnConnected`.
- `add` and `take` need a number input. `amount` is a fixed number, or `{ max, presets, default }`
  for staff to pick (at most 1000). `confirmAbove` asks first above an amount. Add stops at the
  input's `maximum`; a take beyond the balance is refused `no_balance`.
- `set` needs a single-value input; with no `value` the desk offers typed entry from the input's
  schema (`ScanCardAction.input`). `use_up` voids the pass and wants `{{pass.scanCode}}` as the
  barcode message.
- An input a connection syncs is refused `managed_elsewhere` unless `allowOnConnected`; the write is
  then `manual`. A value action publishes the pass with the scan's rows in the same batch; staff can
  undo it. `notify` spends the holder's daily push budget (warning `SCAN_NOTIFY_BUDGET`, except on
  the stamps input).
- An amount over `amount.max`, or an action above the staff role, asks for a Manager PIN
  (`docs/api.md`, "Scanner device actions").

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

2. Tests beside it. `venue-locations` is the model; the others are `expiry-from-input`, `relevance-window`, `upcoming-events` and `beacons`.
3. `npm run gen`. Templates reference it with `behaviors: [{ "use": "my-behavior", … }]`.

Bump `version` when `configSchema` changes in a way that breaks stored configs.

## Add a connector

A connector pulls records from an upstream system and maps them to pass inputs.

1. `src/worker/connectors/<type>/index.ts` with `export default` of a `ConnectorDefinition`
   (`src/worker/connectors/types.ts`):
   - `type`, `version`, `displayName`
   - `capabilities`: `poll`, `delta`, `webhook`, `import`, `snapshot`
   - `webhookReferenceMode` (required): use `embedded-required` when each webhook reference
     needs an embedded record or deletion; use `refs-only` when records can be fetched from the
     upstream reference. This metadata does not enable webhooks without `verifyWebhook`.
     Set it to match the connector's actual behavior: changing it can prevent retained work
     from being replayed.
   - `configSchema` (zod, non-secret; also drives the admin form), optional `secretSchema`
     (write-only, never returned)
   - `outputFields`: the fields templates can bind to
   - `defaults`: `intervalSeconds`, `maxConcurrency`, `requestsPerMinute`, `timeoutMs`
   - optional `urls(config)`: every URL it will fetch, checked against the SSRF rules when saved
   - optional `hasList(config)`, `migrate(oldVersion, config)`
   - `fetchRecord(ctx, ref)`: required; returns `ok`, `not_modified` or `not_found`
   - optional `test`, `listChanges` (cursor paging), `verifyWebhook`, `importRecords`
2. Network only through `ctx.fetch` (HTTPS, public hosts, no redirects, size and time caps).
   Never read the Worker env or log secrets.
3. Failures: throw `ConnectorError('AUTH' | 'FORBIDDEN' | 'RATE_LIMITED' | 'UPSTREAM' | 'TIMEOUT' |
   'INVALID_PAYLOAD' | 'CONFIG')`. `AUTH` and `TIMEOUT` mark the connection unhealthy and never
   change passes.
4. Tests beside it. `demo` (deterministic fake upstream) and `http-json` are the models.
5. `npm run gen`, then create a connection in the admin console and bind passes to it.
