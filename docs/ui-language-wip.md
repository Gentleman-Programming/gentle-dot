# UI language — retained source checks and target integration status

## Current target integration

The renderer and bilingual catalogs are being composed with the selected upstream runtime. The draft card retains its existing app-only approval channel, raw data and callbacks. Catalog composition preserves the earlier message aliases; expanded server-entry guidance has its own key instead of overriding the original missing-token message. Computer copy retains the target's registered-shortcut and Windows-version refusal distinctions.

The historical results below belong to the retained source, **not this enlarged integration candidate**. Current browser, build, UI-suite and full-project typing acceptance are pending. The earlier conflict-resolution check stopped before tests because it selected a nonexistent Node path; this was not evidence that Node was unavailable. Declared dependencies are now installed with lifecycle scripts disabled, but this does not validate UI behavior or native resources.

## Historical retained-source evidence

English remains the default. F2a/F2b cover the language selector and main interface;
F2c T1–T8 now close the bounded renderer-source work for remaining panels and
explicitly owned notices. **Earlier retained-source checks reported:** 549 UI tests,
a Vite build, English/Spanish web-browser assertions and strict selected-root
typing. These results are not current integration proof or exhaustive Spanish
or installed-platform acceptance claim.

## Coverage by evidence layer

| Area | Source/component coverage | Historical retained-source browser scope |
| --- | --- | --- |
| Main/chat/accounts/composer/models | Navigation, shared flows, model/thinking controls, message chrome, answer/PIN wrappers, attachments and authored fallbacks. | Retained checks pass in English and Spanish against the fresh build; synthetic account choice, continuation, draft and model payloads stay exact. |
| Profiles | List/editor/naming/import/delete wrappers and accessible names; raw role/model/profile data and exact callbacks/payloads. | English/Spanish edit/save/duplicate/import and active-delete accessibility guard pass; raw names, unknown model and hidden route remain unchanged. |
| Settings | Shortcut/memory/speech-language body, accessible language selectors, owned fallback versus raw errors. | Not exercised: actual web entrypoint does not expose desktop Settings. |
| Connectors | Management/guide/import/add/draft wrappers; unchanged app-only authority and raw data. | English/Spanish management/import/add passes, including disabled web mutation controls, raw candidate data and exact generated English request. |
| Computer/Dot | Authored banner/entry/dot labels and localized pure display guidance; original readiness and permission distinctions. | Desktop-gated, not exercised. |
| Voice | Device/check/model wrappers and explicitly tagged recording/availability/refusal/check/output notes; raw native/backend boundaries. | No capture, playback, permission or desktop voice panel checks. |
| Status/attachments | Known authored notice/fallback provenance; mounted locale behavior; raw backend errors and attachment transport preserved. | No new browser claims for these branches. |

The final full suite observed **549 passed across 40 files**, exit 0 in 19.04 s,
with empty stderr on the earlier source. Neither that result nor the older
364-test result establishes coverage of this integration.

## Preserved failures and bounded test correction

The initial full run observed **546 passed / 3 failed across 40 files**, exit 1
in 18.62 s. A focused pre-edit reproduction confirmed the same three failures
(14 passed / 3 failed, 17 tests across two files):

- `i18n-controls.test.tsx`: both `localizes the ChatSurface PIN wrapper
  (set=false/set=true) without altering command or state` variants query
  `Read and send` at line 153 while the rendered radio is `Leer y enviar`.
- `switch.test.tsx`: `answer outcome > keeps an error and a stop on the answer
  they belong to`, line 31, expects the old stopped-note shape; actual note also
  contains `display: { kind: "stopped" }`.

The parent authorized only these two test files for correction. Both stale radio
selectors now use `Leer y enviar`. The PIN cancellation expectation also pins the
complete current action, including outer `display: { kind: "pinCancelled" }` and
unchanged nested declined/message/seq fields. The stopped-note expectation adds
`display: { kind: "stopped" }`, retaining all original id/text/stream/note fields.
Every original assertion, exact outbound payload, guard and stored-state check
remains. No production source, cast, suppression or partial matcher changed.

Focused post-correction verification passed **17/17**, then the full project
passed **549/549**. These are actual failing-fixture RED and corrected GREEN
observations, not claims that earlier failures were pre-existing.

## Preserve data, translate only authored display

Conversation content, user/assistant/backend/native text and errors remain raw.
So do supplied empty strings/placeholders, filenames, paths, URLs, PINs, challenges,
keys, IDs, names, autonyms, stored speech languages and protocol/stage/route values.
A backend string that happens to equal English UI copy is still backend data.
Provenance is explicit metadata from known producers, never English text matching.

Exact invariants include:

- `Continue where you left off.` and generated connector requests stay English.
- Duplicate profile names keep `-copy`, independently of the interface locale.
- `Hello, this is the Gentle Dot voice output check.` stays byte-for-byte unchanged.
- `Speech request session limit reached; restart the app` and
  `Speech synthesis is busy` remain raw through exact native sentinel comparisons.
- Native/daemon diagnostic previews and transcription text remain raw. Supplied
  empty native/backend errors retain existing fallback/suppression behavior;
  not every resulting English fallback has owned translation metadata.

Language does not change daemon language, speech-language preference, capture or
authentication behavior. Hide is not Stop; Computer registration/prerequisites are
not session permission. Deferred memory-mode correctness is not a translation fix.

## Historical verification and current limits

Local verification artifacts are not distributed. Fresh integration streams were
recorded separately; historical evidence was left untouched.

| Check | Observed result |
| --- | --- |
| Entire current UI project | Exit 0: 549 passed / 40 files (`ui-002`); initial failure retained in `ui-001`. |
| Focused correction | Before: exit 1, 14 passed / 3 failed (`focused-before-001`); after: exit 0, 17 passed (`focused-after-001`). |
| Current Vite build | Exit 0: Vite 8.3.3, 337 modules (`build-002`), using the parent-resolved existing published CLI. Initial missing shim/exit 127 retained in `build-001`; no build ran then. |
| Sandboxed Chrome 156.0.8078.47 | Exit 0: both English/Spanish checks passed against the current build (`browser-003`). Initial locator ambiguity and old-bundle Spanish failure retained in `browser-001`/`browser-002`. |
| Strict selected entrypoint/tests typing | Exit 0, empty stdout/stderr (`types-002`); roots `main.tsx`, `useVoice.ts`, browser helper, both corrected tests and test setup with their dependencies. Not full-project/test typing. |

All final check stderr streams are empty. Historical failed streams remain
unchanged; the corrected Vite command required no installation or environment
repair, and fresh-build browser checks needed no additional assertion changes.

See [the browser helper contract and reproduction](ui-language-browser-check.md).
No meaningful new behavior RED applies to the helper/documentation portion on
already implemented source. Earlier panel slices retain their behavior RED/GREEN;
the bounded test correction has its own observed failing-fixture RED above.
No source was reverted to manufacture a failure.

LSP tools were unavailable in the integration child. The parent's restart probe
reported zero diagnostics with three confirmed and three inconclusive results,
not global cleanliness. The selected current compiler pass is separate evidence.
No Windows build/copy/install, native/hardware exercise, real sign-in, private
profile reconstruction, environment change or exhaustive platform matrix occurred.
The earlier bounded result is not current integration acceptance; native range
assessments are not review approvals.

## Detailed source boundaries

- [Profiles](ui-spanish-profiles.md), [Settings](ui-spanish-settings-body.md),
  [connectors](ui-spanish-connectors.md), [Computer/Dot](ui-spanish-computer-dot.md).
- [Voice panels](ui-spanish-voice-panels.md), [model](ui-spanish-voice-model.md),
  [recording notes](ui-spanish-voice-recording-notes.md),
  [availability](ui-spanish-voice-availability.md), [refusals](ui-spanish-voice-refusals.md),
  [check notes](ui-spanish-voice-check-notes.md),
  [check producers](ui-spanish-voice-check-producers.md), [output](ui-spanish-voice-output.md).
- [Status notices](ui-spanish-status-notices.md),
  [attachment errors](ui-spanish-attachment-errors.md).

Local feature and installed/platform acceptance records are not distributed.
Neither record was edited by this integration unit; the acceptance limits above
remain unchanged.
