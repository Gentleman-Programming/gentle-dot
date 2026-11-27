# Provider content rejection: say what happened and offer a fresh conversation

Gentle Dot keeps one continuous chat by default. When the AI provider rejects the conversation's
content, every run fails, the chat only says "Please try again", and the user has no way out.

## Specs

- **S1** — Replace the generic answer when the provider rejects the conversation's content.
  Owner's report, verbatim (L1): "Soluciona gentle-dot que se ha quedado atascado y solo responde: Something went wrong while answering. Please try again."
  Engine error observed in the daemon log on 2026-11-26, verbatim: `assistant error: 400: {"code":"1301","message":"System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation."}`
- **S2** — Owner's choice, verbatim (L2): "Mensaje claro y chat nuevo a mano (recomendado)", described as "Detectar el rechazo del proveedor, explicarlo en el chat en vez de “inténtalo de nuevo” y ofrecer empezar una conversación nueva. Cambia solo el daemon y sus tests."
- **S3** — Placement, verbatim from the question the owner answered (L2): "Iría en una rama propia desde main, no en la de gift cards."
- **S4** — Nothing else changes: every other engine error still answers `Something went wrong while answering. Please try again.` (asserted today by `packages/daemon/test/gateway.test.ts:429`), and the chat commands `/login`, `/profiles` and `/connectors` behave as before.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2, S4 | inline, test-first| 4927375 |
| T2 | S2, S4 | inline, test-first| 4927375 |
| T3 | S2 | inline, test-first| 4927375 |

- T1: classify a provider content rejection in the engine error and answer with the specific chat text from L4.
- T2: a `/new` text command that starts a fresh conversation whether or not the conversations feature is on.
- T3: document the new text and the command where the other chat commands and the troubleshooting table live.

## Log

- **L1 (2026-11-26, user):** "Soluciona gentle-dot que se ha quedado atascado y solo responde: Something went wrong while answering. Please try again."
- **L2 (2026-11-27, user):** answered the routing question with "Mensaje claro y chat nuevo a mano (recomendado)" (description quoted in S2); the question stated "Iría en una rama propia desde main, no en la de gift cards."
- **L3 (2026-11-27, evidence):** The stuck service was repaired operationally on 2026-11-26 23:22Z: one image inside a tool result of the open session was rejected by the provider with code 1301 on every request, because the engine resends the whole history (one session since 2026-10-09, no compaction, about 672K tokens per call). That image was replaced by a text note with a backup kept, and the assistant answered again through the WebSocket. Code facts: `packages/daemon/src/bridge.ts:1262-1266` maps every engine error to `ANSWER_FAILED` (`bridge.ts:123`); with `GENTLE_DOT_CONVERSATIONS` off, `new_conversation` is refused (`bridge.ts:678-687`, asserted by `packages/daemon/test/rotation.test.ts:331-338`); typed commands are handled before anything reaches the assistant (`bridge.ts:403`, `bridge.ts:645-661`).
- **L4 (2026-11-27, decisions, agent):**
  - Classifier scope: only a provider content-safety rejection counts (HTTP 400 with code `1301`, or the wording "unsafe or sensitive content"). Quota (429 / 1310), sign-in, 5xx and unknown errors keep the generic text, because for those trying again can work.
  - Chat text for that case (English, like the other daemon strings): "The AI provider's content filter refused this conversation, so the assistant cannot answer here. Trying again usually fails the same way. Send /new to start a fresh conversation."
  - The raw provider message still never reaches clients (`docs/design.md:234`); it stays in the daemon log.
  - `/new` is typed in the chat and handled by the daemon, so it works from the web UI and from text-only bridges. It is immediate, like the New conversation button; it starts a new session through the same path as `new_conversation`; the previous session file stays on disk; the protocol message `new_conversation` stays gated by the conversations feature.
  - Known limit kept: error notes are live-only (history carries no error field), so after a reload the failed turn shows as an empty bubble, as today.
- **L5 (2026-11-27, routing):** the writer dispatch was unavailable in this session (`gentle-ai-worker`: "Writer bootstrap requires the original safe project root"; the worktree registration refused the `/tmp` path). T1, T2 and T3 were written inline in the linked worktree `/tmp/gd-fix-provider-rejection.XQbVBh` as the recorded fallback.
- **L6 (2026-11-27, T1 evidence):** RED: `vitest run packages/daemon/test/answer-errors.test.ts` failed 2 of 8 cases (both refusal cases), and the new gateway test with `packages/daemon/src/bridge.ts` set aside failed with `expected 'Something went wrong while answering.…' to be 'The AI provider's content filter ref…'`. GREEN: the predicate table passed 8 of 8; the two gateway tests ("error while answering" and "refused the conversation") passed 2 of 2.
- **L7 (2026-11-27, T2 evidence):** RED: `packages/daemon/test/new-command.test.ts` failed 4 of 4 (`waitFor timed out`: `/new` reached the assistant as a prompt). GREEN: 4 of 4 passed; `packages/daemon/test/rotation.test.ts` still asserts the refusal of `new_conversation` and passes unchanged.
- **L8 (2026-11-27, checks):** biome on the six changed files: no fixes needed. `pnpm typecheck`: exit 0. Full `pnpm test`: 1153 passed, 3 failed, 31 skipped. The failures: connector-secrets "an unreadable sign-in file never blocks the rest (N2)", which fails on `main` as root as well, and two UI files that timed out under load (`computer.test.tsx`, `settings.test.tsx`); both pass alone (55 of 55) and import no daemon code. `pnpm lint`: exit 0. Differential check, base f97d56d against the change, over the daemon test files that exercise the typed commands and the answer error: 315 shared tests with the same status on both sides, 1 test added (the new gateway test, passed).
- **L9 (2026-11-27, commits):** T1, T2 and T3 in `4927375` (code, tests and docs of the one behavior) on `fix/provider-rejection-escape`; the feature document follows in its own `docs(odd)` commit. Not pushed; merging into `local-deploy` and redeploying stay the owner's decision.
- **L10 (2026-11-27, verification and review):** Independent verifier: 7 of 7 checks passed, no defect (the connector-secrets N2 failure is root-only and also fails on f97d56d in the differential run of L8). Native review `review-b29189470ce75aed`: closed, approved, authority burned; lenses risk (zai/glm-5.4), resilience and reliability (zai/glm-5.3-flash). Three non-blocking advisory findings, left for later work and never a reason to re-run this review: R3-001 (reliability, `packages/daemon/src/answer-errors.ts:4`, SUGGESTION: parse the leading status and the JSON code field instead of free scanning, and add a digit-adjacency row such as 1400/4001), R4-retry-guidance (resilience, `packages/daemon/src/bridge.ts:126-127`, WARNING: the text says retrying usually fails the same way, while a refusal triggered on the generation side can pass on retry), R4-wording-fallback (resilience, `packages/daemon/src/answer-errors.ts:3`, SUGGESTION: require the 400 signature to co-occur with the wording). The provider deferred the cleanup of its candidate view (`candidate-view-git-failure`).
