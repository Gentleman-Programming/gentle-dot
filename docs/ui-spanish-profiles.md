# Profiles display in English and Spanish

Profiles now uses the existing UI locale for renderer-owned labels, actions,
validation, summaries, import notices and accessible names. English remains the
default; this is T2 coverage of S1–S4, not completion of F2c or Windows acceptance.

## Historical evidence

These results belong to earlier retained source, not the current integration.
Joined renderer/type/build/browser validation remains pending.

- New rendered-control tests first failed: 7/7, exit 1, 1.33s. The panel still
  exposed `Profiles`, `New profile` and English import/loading/empty messages
  after choosing Spanish through the existing locale context.
- Focused new plus existing Profiles tests passed: 23/23 across 2 files, exit 0,
  3.90s. An intermediate run caught and corrected a test-only callback count
  expectation (four preceding operations, not five); 22/23 passed in that run.
- Runner output is available in the task transcript as combined tool output;
  independent stdout/stderr captures were not taken.

## Review boundaries

| Requirement | Actual coverage |
| --- | --- |
| S1/S2: continue Spanish UI | Live locale update; profile list/editor/name/delete/import wrappers; thinking labels; loading/empty states and accessible controls. |
| Previous behavior | Existing 16 English reducer/panel/ChatSurface tests remain unchanged and pass. |
| S3: preserve data and behavior | Exact apply/save/rename/duplicate/current/import/delete/account/close callbacks; unknown routes and unavailable model values retained; `Default` as profile/role/model/provider/account text stays raw. Generated `Default-copy` stays exact. |
| S4: environment constraints | Synthetic renderer fixtures and mocked callbacks only. No daemon, profile files, Windows, installs or environment changes. |

Local validation returns semantic message keys directly from the same guards;
no stored string is matched against an English fallback to infer provenance.
Interpolation uses replacement callbacks so data is inserted literally. Backend
errors/descriptions and file contents have no rendering or mutation path in this
panel; no new global error translation or import/file transport was introduced.
Remaining risk is display wording/layout, not a changed protocol or side effect.
Full joint suite, browser layout and installed Windows proof remain parent-owned.
