# Scanner design

Start with `scanner-plan.md`: build order, streams, owned paths, frozen contracts. Where docs disagree, the plan wins
on build structure, `scanner-architecture.md` on design.

| Short | File | Wins on |
| --- | --- | --- |
| plan | `scanner-plan.md` | order, ownership, numbering, contracts (section 4) |
| SA | `scanner-architecture.md` | principals, rights, data, API, reasons, timings, security |
| SD | `scanner-design.md` | everything a person sees |
| DM | `display-model.md` | `scan.display`: schema, limits, renderer, presets, editor |
| BF | `b-final.md` | result screen geometry, tokens and motion |
| BM | `buddy-motion.md` | buddy beats, poses, props, sound |
| AC | `arch-client.md` | reducer tables, decoder, wedge, file tree, tests |
| UD, UK, UA | `ux-door.md`, `ux-desk.md`, `ux-admin.md` | detail SD does not restate |
| PM | `platform-map.md` | facts about the platform's code when these were written |

`buddy-draft/` holds measured CSS and JSX drafts for the buddy. They are a reference; the buddy itself is built in `src/web/scan/buddy`.

## Not shipped

- **Images and video.** The sources for these are empty or missing in the working folder, so there is nothing to
  copy: `directions/b-final/shots` and `directions/b-final/video`, `directions/display/sheets`, `mockups` sheets
  (only `mockups/gen` and its CSS survive, and are not copied), the strips and the webm videos. Paths to them in the
  docs name where they belong. The owner or the lead regenerates them; until then B-final geometry, tokens and
  motion are in b-final.md and buddy-motion.md.
- **`buddy-draft/sound.ts`.** Missing at the source. buddy-motion.md section 12 specifies the chirps.
- **Superseded drafts.** arch-access.md, arch-server.md, map-access.md and map-domain.md are folded into SA and
  the plan, and not copied.
- **Research and briefs.** research/scanning/report.md (R), n8b-buddy.md and scanner-owner-answers.md were the
  inputs. Their decisions are in the revision notes at the top of the plan, SA and DM.

`addendum/` holds the stations and Access card designs the plan cites (ST, AX), the Phase 0 amendments, the customer and desk UX and, in `addendum/occupancy/occupancy.md` (OC), occupancy and desk overrides. Its sheets, shots, gen scripts and pass fixtures are not shipped; paths to them name where they belong.

## Status against the code

Built: scanners, events, staff, scans and gates (`0014`, `0022`), pairing, setups (`0023`), scanning sessions and devices (`0024`, which group devices where `stations.md` has stations), device roles `scan`, `customer` and `monitor` with the live hub (`modules/scan/scan-hub.ts`, `routes-live.ts`), the scan display and its preview, NFC server pieces, member photos (`0021`) and `template_versions.build_key` (`0027`; the docs call it `0018`).

Since then: value actions with undo and Manager PIN approval (SV.5, SV.6b: `add`, `take`, `set`, `use_up`, stamp scans, `ScanCardAction.input`; the `scan` block of the Stamp card blueprint), stateless asset grants (`0061`), the scan read and write side on epochs (SCAN-CORE: `0063`, `0064`), the hard miss cap (`SCAN_TOO_MANY_MISSES`) and PIN-only approval. The round-trip budgets in SA 13.1 are asserted by tests (check-in 5, value action 10, undo 2, lookup 5).

Built since: access zones and plans (`scan_zones`, `0073`), occupancy, tap-out and desk overrides (`0074`, `/scan/overrides`, `/scan/mark-out`). Never built, superseded by scanning sessions: the `scan_stations` table, `scanners.station_id` and the station routes (`0019`); `scanner_zones` is `scanning_session_zones` and `orgs.zones_rev` is `scanning_sessions.config_epoch` with `scan_place_revs`. `addendum/stations.md` is a superseded design. Migration numbers in these files are the plan's, not the repository's: there is no `0019` or `0020`.

Authority: console routes and scanner writes follow `docs/design/authority-epochs.md`. A scanner is unpaired (401 `SCANNER_REPAIR`) only when its credential is lost (`scannerCredentialLost`); every other `credential_epoch` move is 409 `SCAN_CONFIG_CHANGED`. Where older text says `requireAdmin` for a scanning route, read: the session's org membership must hold `scanning:manage` (console) or `scanning:read`; `requireAdmin` is the platform-admin guard and does not apply (`docs/api.md`, "Scanner console").
