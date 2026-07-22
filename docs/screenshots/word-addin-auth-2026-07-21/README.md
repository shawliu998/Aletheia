# Vera Word Add-in authentication acceptance — 2026-07-21

## Visual truth and same-size comparison

- Mike visual truth: `docs/screenshots/mike-v040-baseline/login-1280x720.png`, the saved Mike v0.4 login reference.
- `00-mike-login-reference-560x720.png` is an unchanged, centered 560 × 720 crop of that reference. It was not rescaled or redesigned.
- `06-vera-office-dialog-560x720.png` is the Vera Office Dialog login at the same 560 × 720 size. Compare these two files for the required same-size Mike/Vera acceptance check.
- Vera keeps Mike's centered, quiet login composition and adds only the Office-dialog-specific nonce/session bridge required to recover the existing Supabase session.

## Browser acceptance evidence

The screenshots were captured from a clean temporary production build. The build used syntactically valid, non-secret Supabase fixture environment values only so the static UI could render; no credentials were entered and no authentication or API request was transmitted.

| File | Acceptance evidence |
| --- | --- |
| `01-vera-auth-gate-340x851.png` | Narrow Word task pane authentication gate at 340 × 851. |
| `02-vera-auth-gate-keyboard-focus-340x851.png` | Keyboard Tab reaches “Sign in to Vera” and shows a visible focus ring. |
| `03-vera-auth-gate-125-percent.png` | 125% equivalent viewport, 272 × 681 CSS pixels; document width equals viewport width, with no horizontal overflow. |
| `04-vera-auth-gate-150-percent.png` | 150% equivalent viewport, 227 × 567 CSS pixels; document width equals viewport width, with no horizontal overflow. |
| `05-vera-preview-long-chinese-340x851.png` | Existing task pane preview with long Chinese content at 340 × 851; document width equals viewport width. |
| `06-vera-office-dialog-560x720.png` | Same-origin Vera sign-in dialog at 560 × 720; keyboard focus reaches the email field with a visible 2px focus indicator. |

The invalid-nonce dialog path was also checked: it fails closed, displays only an error alert, and does not render credential fields. Browser console error output was empty during these checks.

## 2026-07-22 visual refinement recheck

The updated OfficeAuthGate and Office dialog were compared against the same saved Mike reference (`00-mike-login-reference-560x720.png`). The new render keeps the quiet off-white canvas, white bordered panel, compact spacing, and Vera/Mike sans hierarchy; the gate and dialog headings no longer use a serif treatment, and neither surface uses a glass or backdrop-blur treatment.

| File | Acceptance evidence |
| --- | --- |
| `07-vera-auth-gate-340x851-mike-sans.png` | Rechecked narrow Word task-pane gate at 340 × 851 after the visual-class update. `scrollWidth`, `clientWidth`, and `innerWidth` were all 340; no horizontal overflow. |
| `08-vera-auth-gate-keyboard-focus-340x851-mike-sans.png` | A keyboard Tab reaches the visible “Vera web app” fallback link and shows its focus indicator. In this standalone Office-script host the primary sign-in control is correctly disabled while the dialog is opening. |
| `09-vera-office-dialog-560x720-mike-sans.png` | Rechecked same-size 560 × 720 Office dialog after the visual-class update. The standalone host shows the expected secure-sign-in completion state; `scrollWidth`, `clientWidth`, and `innerWidth` were all 560, with no horizontal overflow. |

These images were captured from a disposable local frontend run with non-secret placeholder Supabase configuration. No credentials were supplied and no sign-in request was submitted.

## Evidence boundary

This directory records browser-level layout, keyboard, zoom, long-Chinese-text,
and responsive acceptance; those images are not relabelled as Host evidence. A
later 2026-07-22 real Word run completed the separate Office Add-ins gallery
sign-in, activated the XML add-in, opened the Vera login flow, restored the
taskpane session after reopen, and passed Matter loading, selection read,
DeepSeek generation, native comment insertion, and tracked replacement. The
Host record and screenshots are in `office-addin/host-e2e/README.md`.
