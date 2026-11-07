# Composer display localization (T4)

Composer and its file chips use `useLocale().t` with `composer*` keys in the
composed chat dictionary. English remains the default, including the exact
previous labels and disconnected-send explanation. Spanish covers authored
placeholders, failure fallback, file wrappers, and voice/send/stop controls.
The Spanish dictionary retains `satisfies Record<keyof typeof chatEn, string>`.

## Data boundaries

Only display wrappers change. File names, sizes, progress, upload references,
hook refusal/error text, microphone unavailability reasons, voice notes, live
partials, and dictated text remain data. Hook/uploader producers are not
translated here. Recording time formatting and keyboard behavior are unchanged.
Submission still trims text, retains refused drafts/files, reuses uploaded files
on retry, generates request IDs, and sends the same abort payload.

## Evidence and limits

`i18n-composer.test.tsx` renders both Spanish and default English with reset
localStorage and synthetic voice callbacks/upload promises. It checks exact
outgoing text/file payloads, retry counters, Enter/Shift+Enter/IME behavior,
blank/disabled/uploading controls, remove/progress wrappers, recording modes,
callback arguments, hook notes/errors/reasons, and speech-only Stop without abort.
Existing component and attachment suites remain English regression coverage.
No hardware, daemon, browser, network, build, or global type-check proof is
claimed; parent-owned changed-path diagnostics and integration remain separate.
