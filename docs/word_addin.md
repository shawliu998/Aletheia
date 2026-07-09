# Hermes Word Add-in

`office-addin/word-manifest.xml` is a Word task-pane manifest for Hermes.
The task pane is served at `/office/word` and reads the active Word selection
through Office.js. It creates a review-only `word_addin_handoff` work product,
linked human review item, and audit events for a document that already belongs
to the selected Hermes matter.

## Deployment

1. Deploy the frontend behind a trusted HTTPS origin.
2. Replace every `https://localhost:3000` value in
   `office-addin/word-manifest.xml` with that exact origin before distribution.
3. Validate the manifest with `cd backend && npm run check:aletheia:word-addin-manifest`.
4. Sideload the manifest in Word during private-pilot testing, then distribute
   it through the organization's Microsoft 365 add-in catalog only after the
   HTTPS endpoint, authentication, and retention settings have been approved.

The manifest requests `ReadDocument` only. The task pane calls
`getSelectedDataAsync` to capture a selection, but does not use Word write,
tracked-change, or content-replacement APIs. A reviewer must resolve and
approve the Hermes handoff before a human applies any edit in Word.

## Boundaries

- The current Word document must be represented by a document in the selected
  Hermes matter; this preserves the matter/document audit link.
- The task pane is not a legal conclusion and does not automatically accept or
  apply a suggested edit.
- Production rollout requires a real Word desktop/web smoke test with the
  deployed HTTPS manifest. Browser-only tests do not prove Office host runtime
  behavior.
