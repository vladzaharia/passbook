# Audit D: Frontend architecture and UX (wallet)

Scope: `src/admin/client.ts`, `src/admin/studio.css`, `src/studio.ts`, `src/views.ts`, `src/email.ts`, `src/status.ts`, how `src/index.ts` serves them, `scripts/build-assets.mjs` and `scripts/test-admin.mjs`, the screenshots in `artifacts/*.png`, and the sibling `../polaris-key/packages/{admin,brand,ui-core}`.
Method: I read all of the code. I computed contrast ratios with a WCAG relative-luminance script. I checked Cloudflare docs for `run_worker_first` arrays and SPA mode. I did not run the app, any deploy or live script, or the Playwright test. Claims marked **[unverified]** were not executed or checked against a primary source.

---

## 1. Summary

1. Today's UI is a tidy single-tenant vanilla-TS studio: one 281-line imperative `client.ts` and a hand-minified 8-line CSS file. Its behavior is careful (concurrency, idempotency, draft preservation), but it does not scale to a multi-tenant console plus a user portal.
2. Henry's is hard-coded throughout the UI: labels, columns, preview, landing copy, email copy. There is also no real pass renderer. The landing "preview" is hand-built HTML that only approximates one template.
3. There are real performance and accessibility defects: 891 KB backgrounds used as 34 px avatars with `no-store` caching, focus rings at 2.5–2.8:1, several 11–12 px text styles under 4.5:1, light mode only, no i18n.
4. Recommended stack: React 19 + Vite + `@cloudflare/vite-plugin` + Tailwind v4 + Radix/shadcn-style kit + TanStack Router/Query/Table + react-hook-form + zod, with Hono kept as the API. The public pass page should be server-rendered with the same React pass-renderer and ship zero JS.
5. `../polaris-key` already runs almost exactly this stack (React 19, Vite, Tailwind v4, Radix, TanStack Query/Table, RHF, sonner, lucide). It has a dark-first token system (`@polaris-key/brand`, Rubik + JetBrains Mono) and working Pocket ID OIDC + magic-link portal code. Matching it is cheap and gives cross-product consistency.

---

## 2. What works well and should be kept (as behavior, specs and tests, not code)

| Keep | Where | Why |
|---|---|---|
| Optimistic concurrency with `If-Match`. On a 412 the draft is kept, not overwritten. | `client.ts:39`, `client.ts:224`; tested in `scripts/test-admin.mjs:51-55` | This is correct multi-admin behavior. Port it to TanStack Query mutations and keep the test. |
| Idempotent create: the client generates the serial, the fingerprint is reused on retry, and a 409 is treated as success. | `client.ts:231-235` | Safe double-submit or retry on flaky networks. |
| Idempotency-Key on email resend | `client.ts:279` | Prevents duplicate emails. |
| Request sequencing plus `AbortController` for search; 250 ms debounce | `client.ts:183-189`, `client.ts:265` | Avoids race-y stale results. TanStack Query does this natively. |
| Unsaved-change guard on dialog cancel, close and `beforeunload`. Field dirtiness and source dirtiness are tracked separately. | `client.ts:59-61`, `client.ts:127-131`, `client.ts:257-258` | Good UX. Polaris has `useUnsavedChangesGuard` and a router blocker for the same thing. |
| ARIA tabs with arrow, Home and End keys and roving tabindex | `studio.ts:40`, `client.ts:107-111`, `client.ts:261-264` | Correct pattern. Radix Tabs gives it for free. |
| Skip link, `<main tabindex=-1>`, native `<dialog>` with `showModal` (focus trap) | `studio.ts:14`, `studio.ts:22`, `studio.ts:35` | Good accessibility baseline. |
| Honest status semantics: Verified, Configured, Not configured, Attention, Error, plus the note that "Configured" does not confirm delivery | `client.ts:42`, `studio.ts:32`, `status.ts:8-52` | Keep this vocabulary and the honesty in the new Status and Connections pages. |
| Honest delivery copy ("Email acceptance … do not confirm receipt") | `studio.ts:42` | Same as above. |
| Responsive table that becomes cards at ≤700 px, with no horizontal overflow (asserted) | `studio.css:6`, `test-admin.mjs:36` | Keep the pattern and the assertion. |
| Email: table layout, `role="presentation"`, a plain-text part, escaped interpolation | `email.ts:15-16` | Restyle it, but keep the structure. |
| Private-link hygiene: `no-referrer`, `noindex`, "keep private" copy | `index.ts:26-27`, `views.ts:8` | Needed for token URLs, which stay valid without sign-in. |
| `test-admin.mjs` scenarios (create, edit, filters, conflict, unsaved, delivery refresh, source, email, UUID fallback, mobile) | `scripts/test-admin.mjs:22-73` | Use them as the acceptance checklist for the rewrite. Port them to Playwright test files. |

Rewrite outright: `src/admin/client.ts`, `src/admin/studio.css`, `src/studio.ts`, `src/views.ts` (landing). Restyle `src/email.ts`. `src/status.ts` stays as an API, with fixes (see P8).

---

## 3. Problems

Severity reflects the target platform: multi-tenant, OIDC, portal.

| # | Sev | Location | Problem and why it matters |
|---|---|---|---|
| P1 | **High** | `client.ts:21,37,241-253`; `studio.ts:23`; `index.ts:40-42,59-63` | **Admin auth is a shared bearer key kept in a JS variable.** It is re-pasted on every reload ("Lock" just calls `location.reload()`, `client.ts:253`). There is no 401 or expiry handling: after a token rotation the UI only shows "Unauthorized" notices. The admin shell and bundle are public, and the admin shell is the site root (`/`). This is known and will be replaced by OIDC. The new design should gate the admin HTML in the Worker (session cookie → redirect to Pocket ID) before shipping any admin JS. |
| P2 | **High** | `client.ts:79` (labels map), `:81,83` (`message` → textarea), `:96` (advanced fields chosen by name), `:104-105` (preview reads memberName, memberId, homeClub, membership), `:247` (status filter from `inputs.status.enum`); `studio.ts:17` ("Henry's Gymnasium"), `:19` ("Production wallet.plrs.im"), `:28` (columns Member and Home gym); `index.ts:86` (list API derives `displayName`, `memberId`, `homeClub` from Henry's keys); `views.ts:11` (alt "Henry's Gymnasium" for every template), `:16-17` (`startsWith('henrys')` branches, "Your gym pass", hard-coded portal URL); `email.ts:16` ("Your membership pass") | **The UI is coupled to one tenant's field names and copy.** The template `InputField` schema (`types.ts:3-13`) has no `label`, `description`, `group`, `order`, `widget`, `listColumn` or localization, so the UI hard-codes them. Multi-tenancy is blocked until the schema carries presentation metadata. |
| P3 | **High** | `views.ts:10-12,16`; `studio.ts:39`; `client.ts:102-106` | **No real pass renderer.** The member-page "preview" is static HTML that fakes Henry's poster layout. It hard-codes the MEMBER and HOME CLUB labels while the real `posterGeneric` front uses `headerFields:[memberId]`, `primaryFields:[memberName,homeClub]` and `footerFields:[membership]` (`templates/henrys.pkpasstemplate/pass.json`). The barcode is fake CSS stripes. Templates that are not Henry's get a plain panel. The admin shows only a 56×72 thumbnail. The roadmap requires a front and back renderer driven by pass.json. |
| P4 | **High (perf)** | `client.ts:170` (row avatar), `:103` (editor), `:193` (template cards); `views.ts:7,11` (landing); `index.ts:30` (global `Cache-Control: no-store`); `index.ts:46,51,57` (`Uint8Array.from(await loadAsset())`, a double buffer copy); `wrangler.jsonc:8` (`run_worker_first: true`) | **`background@2x.png` is 891 KB** (`public/templates/henrys/`). It is rendered as a 34×38 avatar on every row, in the editor and on the member landing page. Every response, including `studio.js`, CSS and images, gets `no-store`, because Hono's `c.header()` after `next()` rewrites the finalized response (verified in `node_modules/hono/dist/context.js:199-205`). Assets are unhashed and always go through the Worker. Mobile members download about 0.9 MB on every landing visit. Side effect: `passResponse`'s `private, no-cache` (`passes.ts:69`) is also overwritten to `no-store` (backend auditors should check this). |
| P5 | Med | `client.ts:22,27,209-215,255` | **No real routing.** Views use a hash (`#passes`) but `/status` is a pathname. The pass editor, filters and pagination cursor are not in the URL, so a pass cannot be linked to, there is no back-button semantics, and a refresh loses all state and auth. The future pass detail page must be URL-addressable (`/admin/passes/:serial`). |
| P6 | Med | `client.ts:36-41`, `:28-29`; `studio.ts:22,38` | **Error handling.** `response.json()` runs before the `ok` check, so an HTML edge error page shows as a JSON SyntaxError. There is no timeout, no retry and no 401 path. Errors go into one `role="status"` polite region at the top of `main` (possibly off-screen, not focused, not `role="alert"`). Server 400s such as "Invalid memberId format" are not mapped to the field (no `aria-invalid` or `aria-describedby`). |
| P7 | Med | `client.ts:237,250,268,274`; `status.ts:15-49` | **The expensive `/api/status` is called after every save and every list refresh.** It runs D1 counts, a 50-row outbox scan, an R2 head, an asset fetch, certificate parsing per identity and a source query per source. That is coupling: the stats strip should use a light `/api/metrics` with caching. |
| P8 | Med | `status.ts:43`; `status.ts:50`; `studio.css:6` | **Contradictory status line.** APNs state is `unconfigured` while its detail says "Certificate configured" (visible in `artifacts/admin-overhaul-status.png`). Components are sorted alphabetically by id, not by severity, so errors are not listed first. The health dot is hidden on mobile (`.health-dot{display:none}` at ≤700 px). |
| P9 | Med (a11y) | Contrast, computed (WCAG 1.4.3 and 1.4.11): `studio.css:2` focus outline `#b39579` on white **2.80:1**; `views.ts:7` focus `#b6937d` on paper **2.50:1** (non-text needs 3:1); `--muted #72777d` on `--bg #f7f8f9` **4.25:1** (page subtitles at 13 px, status note at 12 px); `th #787e85` on `#fafbfc` **3.96:1** at 11 px; badges at 11 px: warning **4.42**, configured **4.16**, default **4.45**; `.sidebar-bottom #768591` on `#1e252b` **4.09:1**; email footer `#8c7f76` on white **3.88:1** (`email.ts:16`); input borders about **1.4:1**; placeholder `#92989f` **2.91:1** | These fail AA. The UI also leans on 11–12 px text (`font-size:11px` and `12px` appear 19 times each in `studio.css`). |
| P10 | Med (a11y) | `client.ts:209-215` (view switch: no focus move or announcement); `client.ts:171,176` (two tab stops per row doing the same thing, and buttons instead of links, so no open-in-new-tab); `client.ts:82` ("*" with no legend); `client.ts:218-220` (native `reportValidity` bubbles only); `studio.css:6` (`.row-action` `min-height:22px` on mobile, below the 24 px target of WCAG 2.2 SC 2.5.8 unless the spacing exception applies **[unverified rendering]**); `views.ts:17` (↗ and ✧ glyphs read aloud, not `aria-hidden`) | Basic screen-reader and keyboard usability issues. |
| P11 | Med | `studio.ts:11`, `views.ts:7-8` (`color-scheme: light`); `studio.css` (60 hex literals, 55 unique; only 9 custom properties); `views.ts:7` (second palette); `email.ts:16` (third palette) | **No dark mode, which is the stated preference, and no shared tokens.** Three unrelated palettes. Theming per tenant is impossible without tokens. |
| P12 | Med (maintainability) | `client.ts` (26 of 281 lines are over 200 characters, e.g. `:171,:193,:205,:263,:279`); `client.ts:21-25` (15 module-level mutable `let`s); `client.ts:12-15` (`getElementById` with unchecked casts); `client.ts:199` (`el('count-'+k)`); `studio.css` (8 physical lines) | **IDs couple `studio.ts` and `client.ts` by string with no type safety.** A rename fails at runtime. Diffs are unreadable. Parallel agents editing one file per app will always conflict. |
| P13 | Low–Med (i18n) | `client.ts:150,180,200,203` (hand-rolled plurals); `studio.ts:10`, `views.ts:8` (`lang="en"` hard-coded); `client.ts:175,201` (dates in the browser locale inside English UI); `email.ts:16` (no `lang`, `<meta charset>`, viewport or `<title>`; subject is English only, `:14`); `build-assets.mjs:15` (copies `.strings` but nothing in the UI resolves pass localization) | No message catalog, no `Intl.PluralRules`, no locale negotiation. Pass `.lproj` strings are ignored by every preview. |
| P14 | Low | `package.json` (no `playwright`); `test-admin.mjs:25` (`PLAYWRIGHT_PACKAGE` env indirection); `test-admin.mjs` (one 74-line sequential script with `#id` selectors) | The browser test is not reproducible from the lockfile, has no axe or accessibility assertions and no visual baselines. Several screenshots are **stale** against the code: `member-mobile.png` shows "Your membership. Always with you." where `views.ts:17` says "Your gym pass", and `email-preview.png` shows "Your next visit starts here." where `email.ts:16` says "Your membership pass". |
| P15 | Low | `index.ts:29` | CSP allows `script-src 'unsafe-inline'`, but nothing emits inline script today: `landing` never passes `script` to `frame` (`views.ts:8,17`), and the studio uses an external module. It can be tightened now. `style-src 'unsafe-inline'` is needed only because of `views.ts` inline `<style>` and `style=` attributes. |
| P16 | Low | `views.ts:14-18` | The member page ignores `voided`, `expirationDate` and `status` (no "This pass is no longer valid" state). It has no desktop-to-iPhone handoff (no QR code of the link, though the copy says "On your iPhone…"). It has no non-iOS fallback text. |
| P17 | Low | `email.ts:16` | Email: no dark-mode handling (no `color-scheme` meta, so the dark header and white body get inverted unpredictably in Gmail and Outlook), no preheader, the primary CTA is an image only (in image-blocked clients only the alt text shows), and the logo has width but no height. |
| P18 | Low | `studio.ts:10-13`; `index.ts` | No favicon, `theme-color` or manifest. `/favicon.ico` reaches the Worker and returns a JSON 404. |

---

## 4. Not modern best practice, with the modern alternative

| Today | Modern alternative |
|---|---|
| Imperative DOM via `document.createElement` plus string IDs (`client.ts:18-20`) | Declarative components (React 19), typed props, co-located state. |
| Global mutable state with manual sequencing counters (`client.ts:21-25,183`) | TanStack Query for server state: caching, dedupe, abort, retries, `refetchInterval` for pending deliveries, optimistic updates. URL search params for list state. |
| Hash plus pathname hybrid routing (`client.ts:22,213`) | Path-based, type-safe router (TanStack Router) with typed search params (`?q=&template=&status=&after=`), route-level code splitting and loaders. |
| Hand-minified CSS with 55 unique hex values (`studio.css`) | Design tokens (CSS custom properties) with Tailwind v4 `@theme inline` mapping. Dark-first plus `prefers-color-scheme` plus a `data-theme` override. Use the `@polaris-key/brand` model. |
| HTML in template literals (`studio.ts`, `views.ts`, `email.ts`) | JSX components. SSR the public page with `react-dom/server` in the Worker. Email via React Email or a typed table-layout component **[React Email under workerd: unverified]**. |
| `fetch` wrapper with stringly errors (`client.ts:36-41`) | Typed API contract (zod schemas shared by Worker and UI, or Hono RPC `hc<AppType>`, or `@hono/zod-openapi`). A problem-details error shape `{code, message, fields:{name:msg}}` mapped to form fields. |
| Native `reportValidity` plus `confirm()` (`client.ts:129,218`) | react-hook-form with a zod resolver (schema generated from template inputs) for inline accessible errors. An accessible ConfirmDialog. Toasts (sonner) for async outcomes. |
| esbuild script bundling one file into unhashed `public/admin/studio.js` (`build-assets.mjs:7`) | Vite (via `@cloudflare/vite-plugin`): HMR in workerd, hashed assets, multi-entry (admin and portal), dev parity with production asset routing. |
| `run_worker_first: true` for everything (`wrangler.jsonc:8`) | `assets.run_worker_first: ["/api/*","/auth/*","/p/*","/wallet/*","/admin/*","/brand/*"]` (array form, Wrangler ≥4.20, verified in CF docs) plus `not_found_handling: "single-page-application"`. Hashed `/assets/*` are served directly by the edge with long-lived caching. |
| Full-resolution PNGs as thumbnails | Pre-generated or derived thumbnails: the Cloudflare Images binding or `cf.image` resizing **[binding API: unverified]**, `srcset` @1x/@2x/@3x, `loading="lazy"`, and immutable caching keyed by content hash. |
| Single Playwright script | Vitest (unit and component, plus `vitest-axe`), `@cloudflare/vitest-pool-workers` for the API, Playwright test files (one per feature) with `@axe-core/playwright` and visual baselines for the pass renderer. |

---

## 5. Recommended stack, IA and component plan

### 5.1 What `../polaris-key` already establishes

Read from `packages/admin/package.json`, `vite.config.ts`, `src/styles.css`, `packages/brand/css/*`, `fonts/fonts.css` and `README.md`. Installed versions could not be resolved because `node_modules` symlinks point to a missing worktree, so the versions below are the declared ranges.

- **Stack (`@polaris-key/admin`):** React ^19.3, Vite ^6, Tailwind v4 (`@tailwindcss/vite` ^4.3), `radix-ui` ^1.6, TanStack Query ^5.104, TanStack Table ^8, TanStack Virtual, react-hook-form ^7, sonner, cmdk (command palette), lucide-react, class-variance-authority, clsx, tailwind-merge, CodeMirror (lazy). Tests: Vitest ^4 with jsdom and Testing Library, `vitest-axe` and `axe-core`, and Playwright 1.63 e2e against the built SPA under the Worker CSP, with Docker-recorded screenshot baselines.
- **Shape:** two SPAs (customer portal at `/`, operator console at `/manage`) from one Vite build with two HTML entries (`vite.config.ts` `rollupOptions.input`). The Worker serves them from an assembled assets directory. It does not use `@cloudflare/vite-plugin`. It uses `run_worker_first = true` and `html_handling = "none"` (`packages/worker/wrangler.toml:26-30`).
  - Routing is a custom hash router with no router dependency (`src/console/router.tsx:1-20`, `src/portal/router.ts`), with View Transitions and a navigation blocker.
  - Pages are lazy-loaded per section (`src/console/pages/index.tsx`).
  - A single nav table (`src/console/nav.ts`) drives the sidebar, router, top bar and command palette.
  - Layer rules are enforced by a test (`test/boundaries.test.ts`).
- **Strict CSP:** `style-src 'self'`, with the inline theme script allowed by hash. Custom Vite plugins neutralize inline `<style>` injection from sonner, Radix Select, react-style-singleton and CodeMirror (`vite.config.ts:142-235`). Wallet can copy these plugins if it adopts the same CSP.
- **Design tokens (`@polaris-key/brand`):** generated `css/tokens.css`, a Tailwind v4 `css/theme.css` (`@theme inline` → `bg-surface-raised`, `text-fg-muted`, `border-border`, `ring-focus`, `bg-accent`…), `fonts.css`, `tokens.json`, and an accent resolver (`resolveAccent(hex, scheme)` → contrast-checked `{solid,on,fg,subtle,focus}`). Published on a private feed (`@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/`, per `ui-core/README.md`).
  - **Dark-first:** `:root` with no attribute is dark, and light applies only via `prefers-color-scheme: light` or `data-theme="light"` (`tokens.css:10-20,132,281,432`). The persisted choice is `localStorage["pk-admin-theme"]`, applied pre-paint by an inline script (`admin/index.html`).
  - **Dark palette:** page `#060912`, raised `#0d111b`, overlay `#121722`, sunken `#020408`. Text: strong `#fff`, default `#dbe4ff`, muted `#b5bed3`, subtle `#969eb2`. Borders: `#212633` / `#61697b`. Focus: violet `#9a5cff`. Primary action is inverted (`#f6f8ff` with `#060912` on it). Status: success `#56d57b`, warning `#c38d18`, danger `#f2513f`.
  - **Light palette:** page `#f6f8ff`. Status: success `#167337`, warning `#814d00`, danger `#be2323`.
  - Per-service accents via `data-service` (core violet `#9a5cff`, license `#c6e940`, config `#fac700`, release `#00dbfd`, distribution `#39d075`, update `#fe8001`, identity `#d77df2`). Wallet is not one of them; it would need either a new section in brand or a `resolveAccent()`-derived accent.
  - Spacing, radius, type, motion (durations and easings including a spring), and stagger tokens.
  - **Fonts:** Rubik variable (wght 300–900) for UI and JetBrains Mono variable for keys, serials and hashes. Self-hosted WOFF2 split into latin and latin-ext with `unicode-range`. Metric-matched "Rubik Fallback" and "JetBrains Mono Fallback" faces prevent layout shift. `font-synthesis: none`.
- **`@polaris-key/ui-core`** is a headless view-model layer for the licensing SDK UI kits (sign-in state machine, license copy). **It is not relevant to Wallet.**
- **Reusable React kit:** `packages/admin/src/ui/*`, which is not a published package. It includes Button, Dialog, ConfirmDialog, Drawer, Popover, DropdownMenu, Select, Combobox, Switch, Checkbox, SegmentedControl, Input, Textarea, DateInput, form.tsx, StatusPill, Callout, EmptyState, ErrorState, Skeleton, Spinner, LiveRegion, Timeline, DescriptionList, DiffViewer, JsonViewer, CodeEditor (lazy CodeMirror), CopyButton, Timestamp, Duration, PageHeader, Section, ScrollTable, SaveBar, useUnsavedChangesGuard and toast. It also has shell pieces (Sidebar, TopBar, CommandPalette, ThemeMenu, UserMenu, EnvironmentBadge, PageErrorBoundary) and portal sign-in UI (`portal/components/signin/LoginCard.tsx`, `ProviderRow.tsx`). Most of these map one-to-one to Wallet's needs: DiffViewer and Timeline for version history, JsonViewer for pass.json, StatusPill for status, SaveBar and useUnsavedChangesGuard for the editor.
- **Auth reference:** the Polaris Worker already implements Pocket ID OIDC (`packages/worker/src/core/oidc/client.ts`, `services/identity/portal/auth.ts`, with a Pocket ID mention at line 226) and magic-link sign-in (`admin/src/portal/api.ts:1139`, `/api/magic/start`). Treat these as reference implementations; the backend and security auditors should evaluate reuse.

### 5.2 Options weighed

| | (a) React 19 + Vite + CF Vite plugin SPA, Hono API | (b) Hono JSX SSR + htmx/Alpine | (c) Preact or Solid |
|---|---|---|---|
| Fit for admin complexity (data tables, schema-driven forms, live pass preview while editing, template-upload wizard with field mapping, version diff, command palette, front/back flip) | **Best.** Mature primitives (Radix, TanStack, RHF). | Weak. Each interactive widget becomes bespoke Alpine. Optimistic-concurrency and draft flows are awkward over HTML swaps. | Good. Preact via `preact/compat` runs most React libraries, but Radix and compat edge cases exist **[unverified per-lib]**. Solid needs a different ecosystem (Kobalte, TanStack Solid). |
| Bundle | About 60–70 KB gzip baseline for React and ReactDOM **[approximate]**, plus router and query. Fine for the admin; acceptable for the portal. Public pages ship **0 KB** via SSR. | Smallest (htmx about 14 KB gzip). | Preact about 4–5 KB, Solid about 7 KB **[approximate]**. Savings don't matter for the console. |
| Public pass page and SEO-less SSR | React SSR in the Worker (`renderToReadableStream`) of the same `<PassCard>`, with no hydration. | Native strength. | Possible (Preact `render-to-string`), but a second paradigm. |
| Dev ergonomics on Workers | `@cloudflare/vite-plugin` runs the Worker in workerd under Vite with HMR. Production asset routing is honored in dev (CF docs). | Plain `wrangler dev`. Simple. | Same as (a). |
| Testability | Vitest component tests with Testing Library and vitest-axe, plus Playwright. Matches Polaris. | Mostly e2e only. | Vitest and Playwright work; fewer ready-made test helpers. |
| Parallel subagent work | File-per-route with feature folders. Most agent training data is React and Tailwind. | Routes are server handlers. Fine, but UI logic gets scattered across templates and Alpine attributes. | Fewer examples, so more agent errors. |
| Polaris consistency and reuse | **Direct.** Same tokens, kit, test style. | None (tokens only). | Tokens only; kit needs porting. |

**Recommendation: (a).** One Vite project with two client entries (`admin.html`, `portal.html`) plus the Worker (Hono) via `@cloudflare/vite-plugin`, and one `wrangler.jsonc`.

- **Routing at the edge:**
  - `not_found_handling: "single-page-application"`.
  - `run_worker_first: ["/api/*","/auth/*","/p/*","/wallet/*","/admin","/admin/*","/brand/*"]`.
  - The Worker serves the `admin.html` shell only to an authenticated admin session; anyone else is redirected to OIDC.
  - Portal navigations fall through to `portal.html` via SPA mode.
  - Hashed `/assets/*` bypass the Worker.
- **Router:** TanStack Router (file-based, `autoCodeSplitting`, typed search params). Gitignore and regenerate `routeTree.gen.ts` so parallel agents don't conflict on it. This diverges from Polaris's custom hash router on purpose: path URLs give linkable pass pages and let the Worker gate admin HTML. Alternative: copy Polaris's router for full parity (owner decision).
- **Data:**
  - TanStack Query, with one `queries.ts` per feature.
  - A zod contract in `src/shared/contract/<resource>.ts`, used by Hono validators and the UI forms.
  - An error envelope `{error:{code,message,fields?}}`.
- **UI:**
  - Tailwind v4 with `@polaris-key/brand` tokens.css, theme.css and fonts.css (from the private feed), or a forked `tokens.css` if the owner wants Wallet visually distinct.
  - A Wallet accent via `resolveAccent()`.
  - Radix or shadcn-style kit copied or extracted from `polaris-key/packages/admin/src/ui`.
  - sonner, lucide-react, react-hook-form and zod.
- **Theme:** dark default. Respect `prefers-color-scheme` when the user picks "System". Persist the choice. Pre-paint script allowed by CSP hash, as in Polaris.
- **Public `/p/:token`:**
  - Worker SSR with React of `<PassCard>` front and back plus the Add to Wallet badge.
  - A QR code of the URL on desktop.
  - A voided or expired banner.
  - A "Sign in to see all your passes" link.
  - No client JS; a tiny module for the front/back toggle is optional (a `<details>` element or CSS `:target` also works).
- **Email:** keep table layout. Use tokens as inline literals. Add `lang`, `charset`, viewport, `<title>`, a preheader, `color-scheme` and `supported-color-schemes` metas, a text link fallback beside the Wallet badge, and tenant branding from org settings.
- **Tests:**
  - Vitest unit tests (renderer model, formatters).
  - Component tests (jsdom or Vitest browser mode) with vitest-axe.
  - `@cloudflare/vitest-pool-workers` for the API.
  - Playwright e2e: port the `test-admin.mjs` scenarios plus axe.
  - Screenshot baselines per pass style, front and back, light and dark.
  - Add `playwright` to devDependencies.

### 5.3 Suggested source layout (file-per-route, conflict-light)

```
src/
  worker/                 Hono app: routes/<resource>.ts (one file each), auth/, ssr/pass-page.tsx, email/
  shared/contract/        zod schemas + types per resource (passes.ts, templates.ts, connections.ts, users.ts, settings.ts, status.ts)
  web/
    tokens/               tokens.css (brand import + wallet accent), fonts
    ui/                   kit primitives (no app imports, as in Polaris's boundary rule)
    pass-renderer/        model/ (normalize, localize, format, barcode, sanitize) · react/ (PassCard, faces/<style>.tsx, PassBack) · pass.css · fixtures/<style>.pass.json
    admin/
      routes/             __root.tsx, index.tsx, passes/index.tsx, passes/$serial/{index,fields,delivery,versions,source,activity}.tsx,
                          templates/{index,new,$id}.tsx, connections/{index,$id}.tsx, users/{index,$id}.tsx, status.tsx, settings/{general,branding,auth,signing,email}.tsx, audit.tsx
      features/<name>/    queries.ts + components for that feature
      nav.ts              single nav table (Polaris pattern)
    portal/
      routes/             __root.tsx, login.tsx, login/check-email.tsx, index.tsx (My passes), passes/$id.tsx, account.tsx
```

Shared hotspots to serialize between agents: `nav.ts`, `shared/contract/*`, `tokens.css`, the Worker router mount file. Everything else is one file per route or feature.

### 5.4 Admin console IA

Global chrome:
- Org switcher. A platform admin sees all orgs; an org admin sees one.
- Sidebar driven by `nav.ts`.
- Top bar with breadcrumb, Cmd-K palette (jump to a pass by name, email or serial; to a template; to a user), theme menu, user menu and environment badge.

| Section | Pages | Key components |
|---|---|---|
| **Overview** | `/admin` | Metric cards (passes, devices, pending and failed deliveries), alerts (cert expiry, failing connections, failed deliveries), recent activity |
| **Passes** | `/admin/passes` (list with URL-synced filters, saved views, bulk actions); `/admin/passes/new` (template picker → schema form with live renderer preview); `/admin/passes/:serial` | DataTable (TanStack Table, virtualized), FilterBar, PassThumb |
| **Pass detail** `/admin/passes/:serial` | Header: holder, template, StatusPill, version, actions (Push update, Resend, Download, Copy link, Void). Left: **`<PassCard>` with Front/Back toggle and a version picker** that renders any historical version. Tabs as nested routes: **Fields** (schema form, SaveBar, If-Match conflict UI), **Delivery** (email and push Timeline, registered devices, retry), **Versions** (list with a DiffViewer of personalization and pass.json between versions, plus render-at-version), **Source** (linked connection, reference, last sync, sync now), **Activity** (audit) | PassCard, Timeline, DiffViewer, JsonViewer, DescriptionList, ConfirmDialog. Depends on the backend keeping a per-version personalization snapshot. Today only the current one is stored (`passes.ts:60`). |
| **Templates** | `/admin/templates` (baked ones carry a lock badge and "immutable"; uploaded ones are deletable with a usage guard); `/admin/templates/new` (upload wizard: drop .pkpass, .zip or .pkpasstemplate → validate → map fields to inputs, with labels, order, groups and widgets → preview with sample data → publish); `/admin/templates/:id` (renderer preview per style and locale, inputs schema, assets gallery, pass.json viewer, versions, passes using it) | Dropzone, Stepper, FieldMapper, PassCard, AssetGrid |
| **Connections** | `/admin/connections` (status per API source: Healthy / Configured / Failing / Not configured, last poll, error rate); `/admin/connections/:id` (config, write-only credentials, "Test connection", recent sync log, linked passes) | StatusPill, Timeline, SecretInput (Polaris) |
| **Users** | `/admin/users` (holders and admins, linked pass count, last sign-in); `/admin/users/:id` (emails, linked passes as PassThumbs, sessions, roles, invite or disable) | DataTable, RoleSelect |
| **Status** | `/admin/status` (components sorted by severity: Worker, D1, R2, Queues, Email, APNs, signing certs per identity with expiry countdown, connections) | StatusPill, honest-semantics note |
| **Settings** | `/admin/settings/{general,branding,auth,signing,email,domains}` (org name and accent, which feeds `resolveAccent`; OIDC (Pocket ID) and magic-link settings; signing identities and certs; sender address; retention) | Schema forms, SaveBar |
| **Audit log** | `/admin/audit` | Filterable table |

### 5.5 User portal IA

- `/login`: "Continue with Pocket ID" plus an email magic-link form, then a `/login/check-email` state. Errors and rate-limit copy. Polaris `LoginCard` and `ProviderRow` are the template.
- `/` **My passes:** a responsive grid of `<PassCard face="front" size="sm">` for every pass linked to the user's email. Each card has:
  - Add to Apple Wallet.
  - **Refresh**: force update via push. The button shows pending, then done, using Query polling of the delivery state. It has a cooldown and the copy "Wallet may take a minute to update".
  - Last updated, version, and the number of devices.
  - Empty state with help text.
- `/passes/:id`: full front and back render, details, Add to Wallet, Refresh, Download, a link to the public page, voided or expired banner.
- `/account`: emails, sign-in methods, sessions, sign out, theme.
- Public `/p/:token` remains sign-in-free (SSR, see 5.2).

### 5.6 Pass renderer design

Two layers so the same code serves SSR, admin, portal and tests.

**1. `model/normalize.ts`.** A pure function, safe on server and client, with no DOM:

```
(passJson, assets, {locale, personalization?, strings?}) → PassView
```

- Pick the style key in order: `posterGeneric|boardingPass|coupon|eventTicket|storeCard|generic`. For `posterGeneric`, also expose its `generic` fallback so the admin can toggle "older iOS".
- Resolve `.lproj/pass.strings` keys for labels and values.
- Colors: `rgb()` → CSS. Add defaults and contrast-checked fallbacks.
- Format each field:
  - `dateStyle`/`timeStyle` → `Intl.DateTimeFormat`.
  - `isRelative`, `ignoresTimeZone`.
  - `numberStyle`, `currencyCode` → `Intl.NumberFormat`.
  - `textAlignment`.
  - Sanitize `attributedValue`: only `<a href>` with https, tel or mailto survives. Henry's back fields contain HTML anchors.
- Barcode: the first barcode the renderer supports, in `barcodes[]` order (matching Wallet's "first valid" rule), with `altText`.
- State: `voided` and expiry (`expirationDate < now`) give an "invalid" overlay.
- Images: logo, icon, strip, background, thumbnail, footer, artwork, primaryLogo, each with an @1x/@2x/@3x `srcset`.
- Other: `featuredActions`, locations, `logoText`, `suppressHeaderDarkening`.

**2. `react/PassCard`** with `face="front|back"` and `size`.

- Fixed Wallet aspect.
- CSS container queries (`cqw` units) so it scales to any container.
- System font stack (`-apple-system, "SF Pro Text", system-ui`) to look like Wallet, not Rubik.
- Pass colors come only from the PassView, never from app tokens, so it renders the same in light and dark app themes.
- The back renders like iOS's pass-details sheet: a grouped list of label/value rows, auto-linked URLs, phones and emails, and featured actions.
- Barcodes are drawn as SVG (QR, PDF417, Aztec, Code128) by a lazy-loaded encoder such as bwip-js **[Workers compatibility and size unverified]**, or pre-rendered server-side.

Per-style front layout, following Apple's PassKit design guidance, **[to be re-verified against current Apple docs during build]**:

| Style | Front layout |
|---|---|
| **generic** | Logo and logoText left, header fields right. One primary field (large), with a thumbnail to its right. Secondary and auxiliary rows. Barcode at the bottom. With a square barcode, secondary and auxiliary merge into one row. |
| **posterGeneric** (used by Henry's) | Full-bleed `artwork` with `primaryLogo`. Header fields at top (Henry's: memberId). Primary fields over the art (memberName, homeClub). Footer fields (membership). Barcode sheet below. Field set taken from `templates/henrys.pkpasstemplate/pass.json`. **[Apple's exact posterGeneric spec: unverified]** |
| **storeCard** | Strip image behind the primary field (typically a balance). Secondary and auxiliary on one row. Plain rounded card. |
| **coupon** | Strip behind the primary field. Perforated top edge. Secondary and auxiliary on one row. |
| **eventTicket** | Notch cut at the top. Either a strip behind the primary field, or a blurred background with a thumbnail. Primary, secondary and auxiliary fields. Also the poster event-ticket variant when `preferredStyleSchemes` or semantics ask for it **[unverified]**. |
| **boardingPass** | Two primary fields (origin and destination) with a `transitType` glyph between them (Air, Boat, Bus, Train, Generic). Auxiliary and secondary rows. Footer image above the barcode. |

**Tests:** a fixture pass.json per style, with Playwright visual baselines (front and back) and unit tests of formatting and sanitizing. The admin template preview, pass detail, version history and portal cards all reuse `<PassCard>`.

---

## 6. Open questions only the owner can answer

1. **Brand:** should Wallet be a Polaris product, consuming `@polaris-key/brand` tokens and fonts and adding a "wallet" accent or section to brand? Or a visually separate product that only borrows the stack? Should `packages/admin/src/ui` be extracted into a shared published package, or copied?
2. **Router:** path routing with TanStack Router (recommended: linkable pass URLs, Worker-gated admin HTML), or Polaris's custom hash router for parity?
3. **Tenant theming:** may each organization brand the user portal and public pass page (logo, accent via `resolveAccent`), or does Polaris/Wallet chrome stay constant with only the pass art varying?
4. **Domains:** one origin (`wallet.plrs.im` with `/admin` and `/`), or separate hostnames (e.g. `admin.` versus the portal, or per-tenant custom domains)? This affects cookies, CSP and the asset layout.
5. **Locales:** which locales at launch? Must the UI, emails and the renderer honor pass `.lproj` strings per user locale?
6. **Non-Apple users:** is Google Wallet in scope (it affects renderer abstractions and the "Add" buttons), or is it Apple-only with a QR handoff?
7. **Version history depth:** render every historical version (this needs per-version snapshots stored server-side) or only the last N? How long are old `.pkpass` objects retained?
8. **Admin roles:** platform super-admin versus org admin versus read-only? Can holders ever edit their own pass fields in the portal?
9. **Template authoring:** upload only (a pass.json bundle plus a field-mapping wizard), or also an in-browser editor for pass.json and assets (CodeEditor, asset replacement)?
10. **Strict CSP parity with Polaris** (`style-src 'self'`, hashed inline theme script, vendor-style neutralizing plugins): required from day one?
