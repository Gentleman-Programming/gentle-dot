# Spanish account controls

AccountsPanel uses the UI locale for app-authored headings, method choices, search,
status wrappers, action buttons and accessible names. English remains the default.
The account dictionary owns only `account.*` keys in this slice; ModelPicker is
not included.

## Shared flow boundary

The exported FlowEvent and FlowPrompt retain their original props and protocols.
ConnectorsPanel also uses them: its shared buttons and fallback instructions now
follow the locale, but its own panel body is outside this change.

Provider names, subscription names, IDs, OAuth URLs and challenges, device codes,
backend instructions, info/progress messages, prompt messages, supplied
placeholders, option labels/descriptions/IDs and backend failures are displayed
unchanged. Only an absent manual-code placeholder or absent OAuth instructions
uses a translated fallback. Input masking, trimming, optional empty replies,
login methods, cancellation and logout payloads are unchanged.

## Evidence and limits

`i18n-accounts-models.test.tsx` covers Spanish account navigation, search, actions,
status fallbacks and the public shared flow renderers using synthetic callbacks.
Assertions pin outgoing login/logout/reply fields and URL arguments, alongside
unchanged supplied text and codes. `accounts.test.tsx` additionally pins English
fallbacks and default manual-code replies. Existing connector renderer suites
protect the legacy English consumers without changing their fixtures.

No real account login, SDK, daemon, browser, hardware or Windows execution is
covered. Full connector-body translation and ModelPicker remain separate work.
Parent-owned seam/browser checks and independent Risk:item3 review are still
required; renderer coverage is not proof of a live authentication round trip.
