# Vera Product Context

This file is the single authoritative product context for Vera. Historical product and research documents under `docs/` are implementation records, not current product or UI direction.

## North star

Vera helps legal professionals complete legal work and deliver checkable Word, Excel, and conclusion outputs. Sources should be easy to verify in place, with approval added only when the risk of a final or externally controlled output requires it.

Mike is the default baseline for information architecture, navigation, visual design, components, density, interaction rhythm, and workflow. Vera adds only the smallest legal-Agent capability that Mike does not already provide, embedded in existing Mike surfaces whenever possible.

## Product order

Default screen priority is:

1. Matter and work objective;
2. Word, Excel, and conclusion outputs;
3. one-action source verification;
4. approval or requested changes when necessary.

Technical detail appears only when it helps resolve a failure or explains a controlled export. It is not a regular product layer.

The execution layer stays thin: show the objective, three to six steps, outputs, and blockers requiring user action. Do not expose chain of thought, tool-call streams, or developer controls.

Evidence is core but restrained. Prefer precise source deep links and brief location states over a separate evidence workspace. Human review appears according to risk, principally for final, external, or controlled outputs; ordinary drafts and internal viewing should remain frictionless.

Vera does not claim to be fully offline. When a user chooses a cloud model such as DeepSeek or Kimi, relevant content leaves the device for model processing; the product must state that fact at the point of configuration or egress. Existing SQLCipher support may remain for compatibility, but it is not a product claim and should not be expanded without a concrete need.

System Keychain storage for API keys, localhost binding, Matter ownership checks, file-path validation, and factual cloud-model data notices are necessary engineering baselines. SHA-256 is an internal integrity check for approved-version exports, not normal UI content. The single-user stage does not add roles or RBAC.

## Decision filter

Ship a feature only if it does at least one of the following:

- shortens time to complete the legal task;
- improves work-product quality;
- makes sources easier to verify;
- controls a consequential final action.

If none apply, do not build it. Reuse existing Mike routes, objects, and components before creating a new abstraction.

## Non-goals

- Agent consoles, governance centers, or audit consoles;
- multi-Agent control panels or tool-call timelines;
- evidence graphs or confidence dashboards;
- approval at every step or on routine drafts;
- promoting `local-first` on every page;
- technical IDs, hashes, or internal state on primary screens;
- security centers, encryption dashboards, or enterprise RBAC without a defined need;
- a Vera-specific visual system that diverges from Mike.
