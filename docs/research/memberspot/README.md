# MemberSpot investigation

Target: <https://henrysgymnasium.thememberspot.com/>. This directory is isolated from the PassBook runtime. No live connector is registered yet.

## What is known

- The public portal identifies itself as Twin Oaks Software and links to signup, trainer booking, location reservations and classes (public page inspected on 2026-10-30; these are not authenticated API evidence).
- The user reports that additional logins and different IP addresses can trigger verification, and has clarified that sessions do not coexist reliably. Treat non-coexistence as a product constraint; a separate background member session is not a viable design. Exact session lifetime and revocation mechanics have not been measured.
- The user must be able to connect from a phone and continue using MemberSpot on that phone. A desktop-only setup is not an acceptable product flow.
- The PassBook project already has an `UpdateSource` interface in `src/sources/types.ts`, a registered example `membership-api` adapter, and source attachment/sync routes. There is no verified MemberSpot endpoint or payload mapping in this project.
- Shell requests in the investigation session failed DNS resolution for both the portal and an unrelated public host. The web reader could inspect the public landing page but could not provide the login scripts or authenticated network traffic. No login attempt, verification request, or member-data retrieval was made.

## Decision: no competing background member session

The product must support both:

1. A member can connect and complete verification entirely from their phone.
2. Ordinary MemberSpot use on that phone does not repeatedly break the connector or cause the connector to log the phone out.

Given the reported non-coexistence, the earlier proposal to retain a separate browser session on a stable server is ruled out for unattended synchronization. A stable IP does not resolve account-wide session revocation. Do not add retry logic that signs the member back in automatically and displaces their phone session.

The capture script below is developer investigation tooling, not the member onboarding experience. Signing in through it may end the existing phone session. There is no need to repeat concurrent-login experiments to establish a constraint the user has already reported.

Remaining candidates, pending provider and payload evidence:

| Approach | Product behavior | Remaining condition |
| --- | --- | --- |
| Supported club API, feed, webhook or separately scoped authorization | Retrieve and refresh member details independently of the phone login | Confirm actual availability, club authorization, member binding and independence from member-session revocation |
| Explicit import through the existing phone session | Read the open member page and transfer only the required fields to PassBook when the member requests it | Identify fields and an acceptable phone extraction mechanism; this is a snapshot, not unattended synchronization |
| Explicit one-time backend login/import | Retrieve details once, then stop using the provider session | Phone-only login/challenges must work; the import can still displace the existing phone session and must make that consequence clear |

For an import through the current phone session, investigate a Safari Shortcut or an explicitly installed browser extension that reads the currently open MemberSpot page. Apple's [Run JavaScript on Webpage action](https://support.apple.com/en-asia/guide/shortcuts/apdb71a01d93/ios) can retrieve page data from a shortcut invoked in Safari's share sheet. This establishes a platform capability, not that MemberSpot exposes all required fields in the page. Shortcut installation adds onboarding steps and would need product evaluation. No Shortcut or extension is implemented here yet.

Potential import flow:

```text
Phone: existing MemberSpot session → member requests import
                                      ↓ extract required fields on the phone
                              Member reviews captured details
                                      ↓ explicitly submit the snapshot
                               PassBook pass creation or update
```

Our website alone cannot read the MemberSpot page or adopt its Safari/Chrome session. Browser origin isolation prevents reading another site's storage; HttpOnly cookies are also unavailable to page JavaScript. A normal redirect back to PassBook does not transfer those credentials. The explicit Shortcut/extension route operates on the existing page instead of exporting its cookies. See [MDN's same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) and [Set-Cookie / HttpOnly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#httponly).

An import transfers data, not login credentials. Preserve key-tag strings including leading zeroes, record when the snapshot was obtained, and make future refresh an explicit user action. A phone-submitted snapshot is user-supplied data; validation of its shape does not prove current membership eligibility. Do not use it as authoritative access status without independent provider/club verification. A new import endpoint would require its own member authentication and account binding; never place the existing PassBook administrator token in a Shortcut.

Do not attach a polling `UpdateSource` to snapshot-only imports. Register a `memberspot` update source only if an integration independent of the member's interactive session is demonstrated. Preserve the existing pass on retrieval failure and never interpret an authentication failure as a suspended membership.

## Capture on this Mac

From a normal Terminal:

```sh
cd /Users/vlad/Repos/wallet
node investigations/memberspot/capture.mjs
```

1. The script warns that signing in may end the phone session, then opens a dedicated browser profile. Use it only for a deliberate developer capture. Log in and complete verification in the portal if needed.
2. Return to Terminal and press Enter to arm response recording.
3. In the browser, open or reload your profile, membership and member-card pages. This ensures those requests are captured after recording starts. Avoid payment/account-change actions.
4. Return to Terminal and press Enter again. The capture is saved and the browser closes cleanly.
5. Summarize it locally:

   ```sh
   node investigations/memberspot/inspect.mjs
   ```

The script reuses the existing Playwright installation used by this workspace's browser checks. If needed, set `PLAYWRIGHT_PACKAGE` to an installed Playwright `package.json`. Nothing is installed automatically.

The profile is retained for deliberate investigation, not scheduled refresh. Do not rerun captures to compete with normal phone usage. Browser persistence does not establish server-side session validity. An optional account label keeps captures for different members separate:

```sh
node investigations/memberspot/capture.mjs member-two
node investigations/memberspot/inspect.mjs /absolute/path/to/that/capture
```

## Artifacts

All captures and browser profiles live under `.private/<account-label>/`, excluded by this directory's `.gitignore`. The directory is created with mode 0700 and files with mode 0600. Do not paste browser profiles, raw responses or session tokens into chat or commit them.

- `browser-profile/`: reusable dedicated browser state. It does not import your normal Chrome profile.
- `captures/<timestamp>/traffic.json`: request methods, query-redacted URLs, header names, status codes, cookie names and response-file references. The recorder omits submitted request bodies and header values.
- `response-*.js`: portal-origin scripts loaded by the browser, useful for finding actual route construction.
- `response-*.json` / `.html`: portal-origin responses captured after you arm recording. These may contain private member data or session tokens.
- `page-*.html`: page snapshots. `page-start.html` captures the initial portal; other pages are saved at exit.
- `cookies*.json`: cookie metadata without values, including expiry and HttpOnly/Secure/SameSite flags.
- `report.json`: grouped observed endpoints and JSON field/type shapes, without scalar response values. Paths and object keys can still contain identifiers; keep this report private too.

Only portal-origin response bodies are captured. Other origins are listed for later review in case authentication/API traffic uses another host. Capture limits are 2 MiB per response body, 32 MiB total saved response bodies, and 2,000 request records. The browser may download larger resources normally; the limits apply to saved bodies. Check `failures`, `bodySkipped` and `completed` before treating a capture as complete.

## Evidence needed before adding a connector

1. Identify the login and verification requests from observed traffic and client code. Determine whether authentication uses cookies, bearer tokens, CSRF headers or a combination.
2. Identify read requests for the signed-in member and check that every response belongs to the expected account/member. An internal database ID is not necessarily the scannable key tag.
3. For background updates, identify a supported integration with credentials/lifecycle independent of member logins. For an explicit phone import, inspect the existing authenticated page without creating a competing session. Do not spend more logins retesting reported session non-coexistence.
4. Establish the exact field mapping for name, membership, key tag and status. Preserve key-tag strings including leading zeroes. Do not infer active membership from successful login, or invent an expiration date.
5. Verify failure behavior: login redirects, verification pages returned as HTTP 200, 401/403, rate limits, unavailable service, changed payloads, and a member/account mismatch must preserve the existing pass.
6. Demonstrate the selected import/authorization flow entirely from a phone. Do not require a desktop browser, cookie export or Terminal command from members. Any intentional one-time backend login must disclose that it can displace the phone session.
7. Add a `memberspot` update source only for a demonstrated independent integration, reusing the existing authenticated source attachment and `/sync` flow. An explicit import needs a separate authenticated workflow and must not silently enable polling. Test exact field mapping, account binding, data provenance and failures before either integration is enabled. No production deployment or existing pass update is needed for investigation.

The current scripts are capture/inspection tools, not a working login API. Offline validation does not establish that a real MemberSpot session can be reused.

## Validation performed

Both scripts pass Node syntax checks and their help commands work. An offline synthetic capture verified endpoint grouping, JSON type summaries, omission of scalar member/token values from the summary, and mode 0600 on generated reports. The existing Playwright installation exposes the required persistent-context API. Interactive capture against MemberSpot remains untested.

The separate application `npm run typecheck` currently fails at `src/index.ts:87` with TS2571 (`Object is of type 'unknown'`). This investigation changes no application source or configuration.
