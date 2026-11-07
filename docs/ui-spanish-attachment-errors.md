# Attachment refusals and upload defaults in Spanish

Composer now translates attachment-owned refusal and upload-default displays. Raw `PendingFile.refused` / `error` strings, `Uploader`, and outgoing attachment references retain their previous contracts.

## Review boundaries

| Origin | Display rule |
| --- | --- |
| Count, per-file size, combined-size refusals | Optional typed renderer metadata; limits and `formatSize` unchanged |
| Missing/non-string HTTP message, malformed JSON, XHR network failure | Known `UploadFailure` Error carries display metadata; its English `message` is unchanged |
| Non-Error rejection without a message | Existing catch fallback gains display metadata |
| Backend/native Error or legacy unannotated props | Raw display, even when text collides with an owned English default |
| Empty backend/native Error message | Transport stays empty; hook retains its pre-existing English fallback, without translation metadata |

Metadata is in-memory renderer state only. No text matching identifies ownership. Locale changes re-render existing errors; retry clears the error metadata alongside the old error. Refused files still block upload/send, and rejected files still do not contribute to kept-file counts/bytes. No upload, send, auth, progress, clear, remove, or retry control-flow changes are intended.

## Historical focused evidence

These results describe earlier retained source, not this integration candidate.
Joined renderer, type, build and browser validation remains pending.

- RED: `node_modules/.bin/vitest run --project ui packages/ui/test/i18n-attachment-errors.test.tsx` — exit 1; nine missing-Spanish display failures, five passing boundary tests.
- GREEN: `node_modules/.bin/vitest run --project ui packages/ui/test/i18n-attachment-errors.test.tsx packages/ui/test/attachments.test.tsx packages/ui/test/i18n-composer.test.tsx` — exit 0; 35 tests across three files, empty stderr. Existing English tests are unchanged.
- Strict non-emitting TypeScript 7 check from `packages/ui`, selecting the four changed source roots, new test and existing setup — exit 0; both streams empty. This is selected-source typing, not full-project typing.
- Synthetic XHR checks exact method, endpoint, authorization/name headers and file identity. Public hook/Composer checks retain raw strings, limits, counters, locale switching, empty precedence, retry state, shared upload folder, and exact outgoing send references/text/request-ID shape.

CodeGraph identifies production consumers: `ChatSurface.tsx` uses `useAttachments`; `App.tsx` uses `createUploader`; Composer and MessageList use `formatSize`. Their helper signatures/default strings remain compatible. Tests exercise Composer with optional metadata absent as well as the actual hook/uploader path.

This evidence uses synthetic files and mocked XHR only. It does not claim daemon, installed Windows, hardware, browser, or complete F2c acceptance. Null rejection behavior and HTTP-success body validation were not repaired or broadened.
