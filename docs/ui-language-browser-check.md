# Daemon-free UI language check

The standalone helper checks the actual built web entrypoint with synthetic data.
It does not use `playwright.config.ts`, `e2e/serve.ts`, a daemon, real accounts,
stored credentials or the installed Windows application. The results below are
**historical retained-source evidence**, not checks of the current integration.
Rebuild and repeat the listed interactions before claiming current web coverage;
desktop/native and exhaustive translation acceptance remain separate.

## Run with existing dependencies

From the checkout with its declared dependencies installed:

```sh
pnpm --filter @gentle-dot/ui build
node packages/ui/test/browser-language.static-check.ts
```

Build successfully before interpreting a browser result as current-source proof.
The initial `../../node_modules/.bin/vite build` exited 127: that shim was absent,
and no build ran. The parent resolved the existing Vite 8.3.3 published CLI above;
the corrected invocation performed the first actual current build. This path is
specific to the canonical checkout's existing dependencies, not an installation
instruction. No shim, symlink, dependency or environment changes were made.
Native Node TypeScript stripping runs the helper without another runner.

## Safety boundary

The helper requires `/usr/bin/google-chrome`, headless mode, a 10,000 ms launch
bound and `chromiumSandbox: true`. It starts only an ephemeral `127.0.0.1` Vite
preview, blocks non-preview HTTP requests, blocks service workers and intercepts
**all** page WebSockets without connecting to a server. Every locale has a fresh
context containing only synthetic language preferences, history, account data and
a token. Contexts, Chrome and preview close in `finally`, including failed checks.

It never invokes desktop IPC, requests media permissions, captures devices, signs
in, imports real profiles or uses private persistence. OAuth selection and all
other outbound messages terminate in the synthetic WebSocket handler.

## Assertions retained and extended

| Surface | Assertions in each locale |
| --- | --- |
| Main/chat | Accessible account navigation; unchanged conversation title and user/assistant text; token removed from URL. |
| Accounts | Localized heading/search/sign-in labels; exact synthetic OAuth-choice payload. |
| Composer | Localized accessible name and placeholder; unchanged draft; exact continuation phrase and payload keys. |
| Models | Search/option/thinking accessible controls; unchanged provider/model IDs and `off`/`high` payload values. |
| Profiles | Region/close/edit/duplicate/import wrappers; raw `Default`, `active`, `lost/model`, hidden route `x/y`; exact save and duplicate payloads; untranslated `-copy` suffix; active-delete disabled/title guard; import result raw names. |
| Connectors | Region/row/radio/button accessibility; localized status and management/import/add wrappers; raw English-colliding reads/sends/origin/summary; disabled web-only authority controls; candidate URL/key/input data; exact generated English add request; zero connector mutation messages. |

Fixture values reuse the component tests' known raw-data boundaries. For example,
`Connected`, `Read only`, `Off` and `Needs setup` remain data, not translations;
Spanish authored controls include `Perfiles`, `Conectores` and `Solo lectura`.
Accessible-role assertions are not a comprehensive accessibility audit.

## Historical observed result

Fresh `f2c-integration-build-002` evidence records Vite 8.3.3, **337 modules**,
exit 0. `f2c-integration-browser-003` records sandboxed Chrome **156.0.8078.47**,
exit 0 and both `STATIC_UI_LANGUAGE_PASS en` and `STATIC_UI_LANGUAGE_PASS es`.
All listed assertions passed in both locales; final build/browser stderr is empty.
No helper correction was needed after the actual current build.

## Preserved initial failures

Local verification artifacts are not distributed. Each run below retained separate
stdout, stderr and exit records:

- `f2c-integration-build-001`: exit 127, exact Vite executable missing.
- `f2c-integration-browser-001`: Chrome **156.0.8078.47** launched sandboxed;
  failed on an ambiguous English `Read only` locator (raw paragraph and radio
  label). The helper was corrected to scope raw paragraphs and the status chip;
  no fixture data, production behavior or assertion was removed.
- `f2c-integration-browser-002`: against the old bundle, English passed all listed
  interactions. Spanish
  passed the retained main/account/composer/model assertions, then failed waiting
  for `Perfiles`: the DOM contained region `Profiles` and English panel copy,
  alongside Spanish navigation. The helper reads current dictionaries, but the
  served bundle was not rebuilt; this is not evidence of a current-source defect.

Each completed locale prints `STATIC_UI_LANGUAGE_PASS`; browser version is printed
separately and is not a pass. The stale-bundle failure was not bypassed by expecting
English in Spanish; rebuilding current source resolved it.

## Deliberate limits

Settings body, Computer/Dot, voice devices/checks/model panels and desktop approval
paths are desktop-gated in the actual app. This web helper does not fake desktop
identity or relax those guards to expose them. Their source/component evidence is
summarized in [UI language coverage](ui-language-wip.md); it is not browser or
hardware proof. Connector guide/draft branches, native errors, exhaustive Spanish,
real sign-in and installed Windows acceptance also remain outside this browser
result. The earlier bounded web result does not authorize delivery or establish current
integration or installed-platform acceptance.
