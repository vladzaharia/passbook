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

`buddy-draft/` holds measured CSS and JSX drafts for the buddy. They are a reference and are not built.

## Not shipped

- **Images and video.** The rendered sheets (`b-final/`, `display/`, `mockups/`), the strips and the webm videos were
  lost with the working folder and are not here. Paths to them in the docs name where they belong. The B-final
  geometry, tokens and motion are written out in `b-final.md` and `buddy-motion.md`.
- **Superseded drafts.** `arch-access.md`, `arch-server.md`, `map-access.md` and `map-domain.md` are folded into SA and
  the plan, and not copied.
- **Research and briefs.** `research/scanning/report.md` (R), `n8b-buddy.md` and `scanner-owner-answers.md` were the
  inputs. Their decisions are in the revision notes at the top of the plan, SA and DM.
- **`buddy-draft/sound.ts`.** Not kept. `buddy-motion.md` section 12 specifies the chirps.
