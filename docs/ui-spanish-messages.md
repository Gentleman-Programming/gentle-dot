# Message list locale scope (T6)

The existing locale provider now translates MessageList's authored greeting,
earlier-page control/divider, attachment accessible label, queued labels, and
activity-summary grammar. The dedicated catalog uses only `message*` keys;
Spanish satisfies the English key record without casts.

`summarize(activities, translator?)` remains an exported, hook-free utility with
English as its default. Singular/plural templates cover read, edit, run, search,
memory, delegate and other. Counts include all statuses and retain first-seen
kind order. Running activities still show the first running title verbatim.

Conversation text/Markdown, activity titles, filenames/sizes, backend error and
stopped-note contents, duplicate queue entries, CSS classes and callback wiring
are unchanged. MessageList adds no outgoing protocol calls. The synthetic
show-earlier callback test checks exactly one empty-argument application call.

## Historical evidence and current limits

These observations describe earlier retained source, not this integration.
Joined renderer/type/build/browser validation remains pending.

- Before production edits: Spanish renderer suite observed 11 failures and one
  passing raw-running-title case (exit 1), caused by missing translated chrome.
- The first combined run found a test assumption, not a production defect:
  React passes a click event to the existing direct callback. The fixture now
  uses an application callback adapter; production wiring remains untouched.
- Focused tests cover all seven singular/plural rules, mixed order and failed
  status counts, empty/queued-only states, expansion/collapse, unchanged raw
  data, error/stopped notes, streaming caret and exact callback count/arguments.
  English tests exercise the actual exported helper outside React, including
  denied storage, explicit translation, empty input and original English chrome.
- Final focused run: 36 tests passed across two files, exit 0; no stderr.
  Scoped `git diff --check` also exited 0 with no output.
- Validation command:
  `node node_modules/vitest/vitest.mjs run --project ui packages/ui/test/components.test.tsx packages/ui/test/i18n-message-list.test.tsx`
- Parent owns active type diagnostics, final seam and browser proof. Vitest is
  runtime evidence, not a full TypeScript build or Windows/native approval.

S1–S4 self-review: scoped continuation implemented; Spanish display requested by
S2 is available through the existing provider; no authorization beyond T6 is
inferred from S3; no profile, installation, daemon, network or Windows action
was performed under S4. Trackers and other writers' surfaces were not edited.
