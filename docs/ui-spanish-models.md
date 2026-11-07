# Model picker language boundary

The model picker uses the existing UI language preference. Spanish translates
app-authored chip, dialog, search, loading, empty, deferred-choice, profile-group,
in-use and thinking labels. English remains the default with its original wording.

Provider/model/profile names, model IDs, profile routes, search input and backend
errors remain supplied data. Thinking option labels are translated, but their
protocol values (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are not.
Model selection still carries a supported current thinking level, omits an
unsupported level, and sends saved profile names unchanged.

## Verification boundary

`i18n-accounts-models.test.tsx` covers both languages through public renderer
controls, exact outgoing message sequences and dispatch counts. It checks loading
versus empty states, deferred choices, preserved data, keyboard no-op on an empty
search, and focus restoration. Its eight account/flow cases remain unchanged.
`model-picker.test.tsx` retains the existing English chat/reducer integration
regressions. All fixtures are synthetic; these checks do not prove browser,
installed desktop, Windows, daemon, account authentication or hardware behavior.
