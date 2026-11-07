# Connector management in English and Spanish

Connector management now follows the existing UI language preference. Status chips, actions, accessible names, add/import forms, guide wrappers and flow summaries are translated; connector data is not.

## Review boundary

- Start with `ConnectorsPanel.tsx` and its typed `connectorEn`/`connectorEs` catalog. Status keys follow protocol states, never English-string matching. Name interpolation uses replacement callbacks, preserving literal user/backend text.
- `addConnectorRequest` and its outgoing callback are unchanged. Desktop restrictions, mode values, state guards, dispatches and send routing are unchanged.
- Raw names, reads/sends, custom origins/summaries, guide steps/notes/link labels, candidate notes/reasons/sources, keys, URLs, flow messages and supplied empty errors remain raw. The imported protocol `APP_REQUIRED` notice remains unchanged.
- Shared `AccountsPanel` flow components and Computer/Voice children are untouched. ConnectorDraftCard's authored wrappers are translated in the separate follow-up described below; its native approval guard and data remain unchanged.

## Historical evidence and current limits

The test results below describe earlier retained source, not the current
integration candidate. Joined renderer/type/build/browser validation remains pending.

Synthetic public-control tests observed eight missing-Spanish-display failures before implementation. Initial GREEN: 33 tests across the new locale file and both existing connector files. Added status, setup/cancel and success triangulation: 39 passed, stderr empty. Tests preserve the exact generated English add request, separate app/send transports, raw English-collision data, empty versus missing failure messages, import count grammar and desktop-only restrictions.

## Separate draft-card follow-up

Eleven authored labels now follow the interface language, including accessible title, HTTP/stdio headings, secrets/OAuth help, privacy guidance and Add/Decline. Descriptions, names, URLs, commands/arguments, key names and `APP_REQUIRED` remain raw. Replacement callbacks insert `$&` literally.

Two rules in both English and Spanish first observed 2 English passes and 2 missing-Spanish failures; all 4 then passed. Strict TypeScript caught a missing required `description` in the new stdio fixture; supplying its empty string fixed only that test data. Final renderer 4/4 and strict non-emitting source checks both exit 0 with empty stderr. Assertions pin exact desktop approval and web-disabled approval/decline callbacks, no draft/preference mutation, raw fallback-identical text, and unchanged transport strings. No native permission or session contract changed.

These checks are renderer-only: no connector login, browser launch, daemon, native action or installed-Windows acceptance was exercised. Joint full-application checks remain pending. These historical observations do
not establish current integration or installed-platform acceptance.
