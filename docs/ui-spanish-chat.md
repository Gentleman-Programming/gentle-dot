# Spanish chat chrome (T2)

Choose Spanish in Settings → Interface language. The header, connection guidance,
account onboarding, interrupted-answer and conversation-switch controls, notice
dismissal, and mute/rose/full-screen labels use the existing locale provider.
English remains the default with its original wording.

## Data boundary

Conversation titles (including a title literally named `New conversation` or an
empty title), notice bodies, and native connection/error reasons remain data.
Only a missing title receives the translated fallback. The visible `Continuar`
button still sends exactly `Continue where you left off.` with the original
`send` type and generated request ID. Navigation commands and toggle booleans
are unchanged; changing the UI language does not send protocol commands.

## Evidence and limits

`packages/ui/test/i18n-chat.test.tsx` exercises Spanish labels and tooltips, all
five connection/startup states, onboarding, both continuation locales and exact
payload shape, empty/data conversation titles, new/existing conversation switching
and cancellation, notice dismissal IDs, both toggle states, live locale changes,
and App-owned guidance/error wrappers. Existing header, Settings and locale tests
provide English/foundation regressions. All fixtures use synthetic state and mocked
transports/native controls: no daemon, hardware, login, or private profile.

This slice does not translate Composer, MessageList, AskCard, PIN dialogs/forms,
model picker, computer banners, other panel bodies, or backend-generated text.
No browser, installed Windows, real native integration, or full-project type-clean
claim is made. Parent integration owns seam/browser checks and changed-path LSP.
