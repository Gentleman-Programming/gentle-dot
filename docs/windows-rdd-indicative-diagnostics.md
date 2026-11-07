# RDD status: indicative diagnostics

Failed `dot_review_status` responses include fixed English manual guidance in a
second SDK text-content block. The first JSON text block
and `details` retain their existing exact shapes; successful responses still have
only their original text block. Guidance does not establish health or authorize
repairs, mode changes, installation or another invocation.

## Read the result

The existing `non-zero` failure can include an `indicativeHint`, for example:

```json
{"ok":false,"readOnly":true,"category":"non-zero","indicativeHint":"unreadable_mode_value"}
```

The second block is JSON with only `code`, `summary` and `steps`. Its strings come
from the finite SDK-independent `diagnostic-guidance.ts` catalog. Unknown inputs
receive a cautious generic guide; arbitrary error text is never echoed. The same
catalog supports bounded metadata observations, bundled SDK/codemode/native CLI,
Git, system PowerShell, memory, MCP and WebView2. Metadata presence is not health;
bounded file absence is not machine-wide absence, and cached connections are history.

The current RDD hint values are `unreadable_mode_value`,
`unsafe_clone_mode_path` and `git_unavailable`. Unmatched, ambiguous or oversized output has no hint:
the indication is unknown, not proof that either condition is absent. Other
failure categories keep their original category and receive fixed guidance.
`git_unavailable` requires the public native repository-identity prefix together
with the public Go Windows Git-lookup suffix, within an eligible unchanged status
request. It suggests the review process could not locate Git; it does not prove
machine-wide absence, the exact launch-environment cause, or disabled RDD. Install
Git manually only if absent; otherwise make the existing installation available
when launching the application. No automatic action or extra query is performed.
Producer references: [native wrapper](https://github.com/Gentleman-Programming/gentle-ai/blob/v4.0.0/internal/reviewtransaction/rdd_mode.go)
and [Go lookup](https://github.com/golang/go/blob/go1.25.10/src/os/exec/lp_windows.go).
Synthetic fixtures use those public templates, never owner diagnostic originals.

## Boundaries

The normal public SDK adapter still receives the same request once and returns
the same result or throws the same error. Its resolver, options, environment and
status calls are unchanged. Only the fixed `review mode status --cwd … --json`
request is used. The finite hint parser inspects only bounded stderr from nonzero
results without a signal, timeout or output-limit condition. The public facade
retains only a finite hint and sanitized category, never original errors/stacks.
There are no added identity, version, fallback or remediation calls.

Templates come from the public [v4.0.0 review mode source](https://github.com/Gentleman-Programming/gentle-ai/blob/v4.0.0/internal/cli/review_mode.go),
not proof of the installed native version. These are text-template indications,
not native codes, causes, actual mode facts, ACL findings or repair authority.
Synthetic or malicious text can imitate a template. Paths, record values and
commands are never returned. No automatic repair or mode change is authorized.

## Private capture retired

The optional Settings debug preference, private trace flag and native viewer are
retired; see [capture retirement](rdd-private-transport.md). Existing stored data is
untouched. Status and finite guidance remain, without a replacement collector.

## Source verification

The focused `diagnostic-guidance.node-test.mjs` and
`review-status-guidance.node-test.mjs` tests cover the catalog and additive block.
The existing `review-status-hints.node-test.mjs` suite protects hint templates;
`review-status.node-test.mjs` protects injection, activation and restricted roles.
Fixtures replace only the public SDK module in memory and perform no native
execution, SDK session, profile reads or network requests. These tests do not
establish Windows operation, installed-app recovery, dependency health or full typing.
