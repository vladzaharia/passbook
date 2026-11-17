# Blueprints and templates

Passes are issued from templates. A blueprint is a PassBook design to start from.

## Words

| Word | Meaning | UI |
| --- | --- | --- |
| Template | An organization's pass design. Passes are issued only from templates. | Templates page |
| Built-in | A template that ships with PassBook (Henry's). Read only; Duplicate to change it. | `Built-in` badge on Templates |
| Uploaded | A template an organization added (upload or designer). | No badge; the Origin filter keeps the word |
| Blueprint | A PassBook design to start from. Never issued. **Use blueprint** makes a template from it. | Blueprints page, `Blueprint` badge |

Henry's templates are built-in but not blueprints. Blueprints are built-in too, but the UI only says Blueprint.

Buttons and links: **Use blueprint** (page action, dialog title), **Use** (tile), **Browse blueprints** (empty
states, links), **New template** (Templates header; opens Blueprints), **Create template** (designer save, phone
dialog).

## Where

- `/admin/templates`: the selected organization's templates. Blueprints never appear.
- `/admin/blueprints`: platform-wide and read only; the org switcher hides. A member sees it through the selected
  organization (its pass counts and branding).
- `/admin/blueprints/:id`: glyph, `Blueprint` badge, **Use blueprint**, tabs Overview and Inputs. A link to
  `/admin/templates/<blueprint id>` redirects here.
- `/admin/templates/new?blueprint=&orgId=&name=`: the designer on a draft. Nothing exists until **Create template**.
  On a phone the Use blueprint dialog creates the template as it is.
- Pickers (new pass, connections, scanning) list templates only, with **Browse blueprints** when there are none.

## Data

- `"blueprint": true` in a baked package's `wallet.template.json`. An uploaded manifest with the key is refused
  (`MANIFEST_BLUEPRINT`). `display.icon` names the blueprint's glyph from the curated scan icons.
- `templates.blueprint` follows the manifest at each baked sync (`migrations/0056_blueprints.sql`).
  `templates.source_blueprint` is set on a template made from one; the summary shows it as `fromBlueprint`.
- `POST /api/v1/templates/{id}/use` makes the template in the org through the template write grant
  (`templates:author`), with the blueprint fenced as the source. Its first version is a candidate: the usual
  review (author is never the reviewer) and publish release it. Errors: 404 `TEMPLATE_NOT_FOUND`,
  409 `TEMPLATE_EXISTS`, 422 `TEMPLATE_NOT_BLUEPRINT`.
- A blueprint cannot be assigned to an organization (409 `TEMPLATE_IS_BLUEPRINT`).

## Issuing

Creating a pass from a blueprint answers 409 `TEMPLATE_IS_BLUEPRINT`: "Passes come from templates. Use this
blueprint to make one first." The check sits with the release head on every create (admin, API, connection
records, scanner samples), and the create grant holds it at commit. Connections refuse a blueprint on create and
update; a connection left on one skips new records with the code.

The baked sync keeps each blueprint's `system` release heads, so passes already on a blueprint keep updating,
refreshing, voiding and reissuing under the issued-release rule. The blueprint page shows them as "N passes from
before blueprints" with View pass.

## Upgrades

A new blueprint version (colours, art, the flag itself) is a new content hash; the baked sync publishes it and
the stale-reissue cron rebuilds the old passes. Field values and change messages are unchanged, so Wallet updates
them silently. An org's own brand colours still win on its passes.

## Placeholder art

`PLATFORM_BRANDING` fires when a pass ships a logo or icon with the hash of a blueprint's file. Templates made from
blueprints carry the same files, so the id is not enough. Replace the art in the designer or in the organization's
pass branding.
