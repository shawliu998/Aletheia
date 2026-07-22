# Vera Word Add-in

Vera keeps two manifest formats because Microsoft 365 unified manifests are not
supported by every Office client. Both formats open the same `/office/word`
taskpane and use the same Vera Supabase authentication and API authorization
boundary.

| Manifest | Purpose | Add-in ID |
|---|---|---|
| `office-addin/word-manifest.xml` | Compatible add-in-only XML for older or unsupported Office clients | `6bf488ac-2916-4f3e-bdc0-8d7f66e7ab2e` |
| `office-addin/manifest.json` | Unified Microsoft 365 package for supported clients | `495c91ee-b02c-4ae2-8ef8-c3aedf62dc87` |

The IDs intentionally differ. Microsoft requires the unified and add-in-only
versions to be distinguishable when both are deployed. The unified manifest
links the XML add-in through `alternates.hide.customOfficeAddin` so supported
clients do not keep two Vera ribbon controls after propagation.

## Word 16.111 and manifest support

Microsoft documents unified-manifest sideloading for Excel, PowerPoint, and Word
on Mac 16.103 or later. Word for Mac 16.111 therefore meets the client-version
floor for `office-addin/manifest.json`. The unified manifest uses the Microsoft
365 app manifest 1.29 schema, the `document` scope, `WordApi` 1.3,
`AddinCommands` 1.1, and delegated `Document.ReadWrite.User` permission.

The XML manifest remains the compatibility path. It uses Vera branding,
`ReadWriteDocument`, the same taskpane route, and the same 16, 32, and 80 px Vera
command icons. Both permissions are required because the taskpane can create a
tracked replacement or a Word comment. Vera never accepts a tracked change for
the user.

That write permission also explains the native read-only behavior: Word for Mac
disables Add-ins and the Vera ribbon command before loading the taskpane when a
document is opened read-only. Vera therefore cannot truthfully offer generation
inside that native read-only window without giving up tracked changes/comments in
editable documents. The loaded-runtime write failure remains handled for cases
where an already-open document later becomes protected or non-writable.

The two formats have different acquisition boundaries. The add-in-only XML can
be sideloaded locally on Mac by copying it into Word's `wef` folder; that step
does not register a package through Microsoft Graph and does not itself require a
work or school tenant. Word still needs a licensed, signed-in Office identity.
On 2026-07-22 the available personal Microsoft account completed the Office
Add-ins gallery sign-in, the XML manifest activated in Word 16.111, and the real
taskpane/ribbon command loaded. The successful Host run is recorded in
`office-addin/host-e2e/README.md`.

The unified package has a separate acquisition path. Its manifest and icons pass
repository and official validation, but the current Agents Toolkit install flow
uploads/registers the package through Microsoft 365 and requests tenant-scoped
`AppDefinitions.ReadWrite` permission. That login rejected the available
personal Microsoft account, so a work or school tenant remains a condition for
this unified-package test, not for the working XML development path.

Microsoft references:

- <https://learn.microsoft.com/office/dev/add-ins/testing/sideload-add-in-with-unified-manifest>
- <https://learn.microsoft.com/office/dev/add-ins/develop/unified-manifest-overview>
- <https://learn.microsoft.com/office/dev/add-ins/concepts/duplicate-legacy-metaos-add-ins>

## Office Dialog authentication

`/office/word` restores the existing Supabase browser session first. If the
Office taskpane webview has no Vera session, it shows one sign-in action and
opens `/office/auth/dialog` with `Office.context.ui.displayDialogAsync`.

The dialog is a separate, non-iframe Office webview. It signs in with the same
`supabase.auth.signInWithPassword` method as the Vera web login, observes the
existing MFA-on-login gate, then retrieves the official Supabase session. The
dialog sends the access and refresh tokens directly to the taskpane with
`Office.context.ui.messageParent`, constrained to the exact taskpane origin.
The taskpane checks the message origin when Word provides it, verifies a fresh
cryptographic nonce on every response, and passes the credentials to
`supabase.auth.setSession`. Supabase then owns persistence, refresh, auth-state
events, and the bearer tokens used by `mikeApi`.

This flow does **not** create a local token, copy a desktop bearer, add a backend
token-exchange endpoint, or bypass Supabase/MFA. Tokens are never placed in a URL
or logged. The separate dialog is necessary because Office on Mac and Office
webviews can block identity forms inside a taskpane iframe and do not reliably
share browser storage with the dialog.

Microsoft reference:

- <https://learn.microsoft.com/office/dev/add-ins/develop/auth-with-office-dialog-api>

## Local HTTPS development

All committed manifest URLs use `https://localhost:3000`. This is a development
origin, not a production deployment claim. Install and trust a Microsoft Office
development certificate before sideloading. If the frontend calls the repository
backend during local HTTPS testing, use the existing HTTPS proxy documented in
`office-addin/host-e2e/README.md`; do not relax mixed-content, API authentication,
or backend bind-address controls.

The Word webview must also receive an HTTPS Supabase URL and the real local
publishable key at frontend startup. For the verified local run, the same
`https-backend-proxy.mjs` was used on port 54322 with local Supabase on 54321,
while the repository API proxy remained on 3002. The backend loaded the existing
`USER_API_KEYS_ENCRYPTION_SECRET` from its local `.env`; omitting it makes saved
model keys visible as configured but impossible to decrypt. Do not generate a
new encryption secret for an existing local database.

For a deployed pilot, replace every `https://localhost:3000` URL in both
manifests with the exact approved HTTPS frontend origin. Update the unified
package icons and the developer website/privacy/terms URLs only to approved,
real HTTPS endpoints, and replace the unified manifest's `localhost:3000`
`validDomains` entry with the deployed host (without `https://`). The Office
dialog's first and final Vera pages must remain on the exact taskpane origin,
including protocol, host, and port.

## Validation and sideloading

Run the repository audit and TypeScript checks:

```bash
node office-addin/scripts/check-manifests.mjs
npx --yes office-addin-manifest@2.1.6 validate office-addin/word-manifest.xml
cd frontend && npm run test:word && npx tsc --noEmit
```

Validate the unified manifest against the current Microsoft 365 app manifest
1.29 schema or with the Microsoft 365 Agents Toolkit before packaging. A unified
app package must contain `manifest.json` plus the referenced 32 px outline and
192 px color icons under `assets/`. The official debugging tool can normally
package and sideload it for a development run:

```bash
npx --yes office-addin-debugging@6.1.2 start office-addin/manifest.json desktop
npx --yes office-addin-debugging@6.1.2 stop office-addin/manifest.json
```

On the 2026-07-22 Mac host, the currently published 6.1.2 npm dependency graph
could not be installed directly because its Agents Toolkit peer range had no
matching stable release. A temporary install with explicit dependencies was used
only to inspect the official flow; nothing was added to the repository. The
validated package was therefore also built directly as
`/tmp/vera-word-unified-20260722.zip`, containing only `manifest.json` and the two
referenced icons. Its SHA-256 for that run was
`60d1f22cca8a0818df3c1d27b30507d2b757dab498081a5131fd92f3554ae709`.

Unified installation through the current Agents Toolkit flow still requires an
authenticated Microsoft 365 work or school tenant. A personal Microsoft account
may be used to join the Microsoft 365 Developer Program, but only qualifying
members receive an E5 developer sandbox and its tenant identity. Do not bypass
the tenant permission or replace it with a Vera authentication workaround.

The XML path can continue to use Microsoft's manual Mac sideload procedure.
Production distribution must use the organization's approved Microsoft 365
catalog or Marketplace process after the HTTPS endpoint, application login,
tenant policy, and retention settings have been approved.

## Acceptance boundary

The taskpane workflow comparison remains in
`docs/screenshots/word-addin-mvp-2026-07-21/`. The same-size Mike/Vera login
comparison and the keyboard-focus, long-Chinese-text, 125%, 150%, and responsive
login checks are recorded in
`docs/screenshots/word-addin-auth-2026-07-21/README.md`. Browser rendering is not
used as Word Host evidence. The 2026-07-22 Word 16.111 run passed XML activation,
Vera sign-in and session persistence across taskpane reload, Matter loading,
selection read, DeepSeek generation, Matter-chat persistence, Word comment
insertion, tracked replacement without automatic acceptance, and restoration of
the current review after closing and reopening the taskpane. Review restoration
stores only a short-lived Matter/chat pointer and disposition metadata in the
Office webview; the instruction, suggestion, and citations are rehydrated from
the existing Matter Chat rather than duplicated locally. A later real-Host pass
also verified stale-selection rejection, native comment and tracked-change
persistence after save/reopen, and 125%/150% zoom in the synthetic document. The
native read-only fixture correctly disabled the add-in at the Word host boundary;
bridge tests cover a loaded document becoming non-writable. A later authenticated
74k-character Host run completed all six paragraph-boundary sections, located the
late English and Chinese clauses, inserted one pending tracked replacement and one
native comment, and preserved both plus the Vera review decisions after save and
reopen. Clean normal, 125%, 150%, and keyboard-focus captures are recorded in
`office-addin/host-e2e/screenshots/`. The remaining deployment-path checks are
unified-package acquisition and MFA-on-login on an enrolled non-production test
account; neither is bypassed by the working XML development path.

Document-wide review now reads the complete Office.js body and sends
paragraph-preserving sections through the existing Matter Chat. Completed
sections remain recoverable when a later stream is canceled or incomplete.
Provider queue responses retry the same section with bounded backoff; an SSE
error retains its returned `chat_id` so the retry stays in the same Matter Chat.
Document suggestions reuse the existing citation-anchor locator with both the
paragraph ordinal and original paragraph text. Word verifies both before adding
a comment or tracked replacement and blocks the write if the paragraph moved or
changed. Document-wide replacements containing paragraph breaks are rejected
because they could invalidate later anchors; the user can review that passage as
a selection instead. These are safeguards inside the existing Word flow, not a
new audit or security surface.
