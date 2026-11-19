# Gentle Shell compatibility

Gentle Dot pins published Gentle Shell (`gentle-pi`) 4.9.0. Dot preserves its existing version-1 profile workflow metadata, introduced alongside Shell 4.7/4.8. This is not a new UI control, permission to enable delegation, or installed-engine certification.

## Stored profiles

Gentle Shell's existing version-1 profile workflow format may include:

```json
{
  "workflow": {
    "delegated": { "orchestratorMode": "full-delegation" }
  }
}
```

The name must identify a stored profile. Dot omits the default `organic` mode, invalid modes, and orphan workflow entries. Existing organic-only stores retain their previous shape.

Saving routes or applying another profile preserves existing workflow entries. Renaming or duplicating a profile carries its workflow metadata; deleting it removes that profile's entry. An import with identical routes but a different workflow mode is not an identical profile: it receives the normal collision suffix. Repeating that import does not duplicate it again or alter the source store.

## Packaged runtime

The daemon dependency and pnpm importer, package entry and resolved snapshot select `gentle-pi` 4.9.0. [Official npm metadata](https://registry.npmjs.org/gentle-pi/4.9.0) identifies source commit `ce64a9a708e50c0ca899c8023140e63f29f293e1` and integrity `sha512-ro5vdmWX2GcEB8QnS739+LO37MfmpYI7jeEWCt7pAu54VWXsOL2I5zPM2rBHeh79Kt227wU4jdqLp1TZGzXSYA==`. These are registry provenance inputs, not a locally downloaded or verified runtime artifact.

Its runtime dependency (`@heyhuynhgiabuu/pi-pretty` 0.6.27), optional Pi peers and Node engine range remain unchanged from 4.8.0. Node.js 24 remains supported. The existing Pi SDK 1.5.0 dependencies and matching runtime sibling overrides remain pinned: the declared coding-agent peer is still `>=1.2.0`, so upgrading the SDK to the separately published 1.5.2 is not necessary for this dependency-selection change. Declared peer compatibility does not prove a real engine session works.

Dot continues to use the bundled `bin/gentle-shell.mjs` launcher and its RPC interface. Its existing protection removes an inherited `GENTLE_SHELL_INTERACTIVE_HOST` only after identifying Dot's own bundled default engine. Explicit `GENTLE_DOT_AGENT_BIN`, `GENTLE_DOT_AGENT_SCRIPT`, and `GENTLE_DOT_AGENT_ARGS` choices retain their environment. No launcher, environment-control or provisioning logic changes with this pin. This update does not introduce structured Desktop widgets, canvas, or permission controls; Dot's existing extension-dialog routing remains unchanged. Dot's explicitly selected Engram binary is not automatically upgraded by Shell's companion defaults.

## Verification boundaries

Run the dependency-selection contract without installing packages, compiling Go, or launching an engine:

```sh
node --test scripts/windows/test/gentle-shell-compatibility.test.mjs
```

It checks source and packaged-runtime lock selection, exact retained SDK/sibling consistency, inherited interactive-host refusal and custom/platform environment preservation. The 4.9 selection expectation was observed RED against the old 4.8 pin before the dependency/lock update. It does not prove an installed engine works. The existing `runtime-build.test.ts` expectation also selects 4.9.0, but that suite builds runtime artifacts, has Windows native-addon prerequisites, and its project setup compiles the private-storage helper. Real SDK loopback tests and staged-runtime smoke checks are separate functional evidence; none may use personal profiles or real provider credentials.

Profile-format tests exercise synthetic files through the public profile store and format functions. They never migrate real user data or invoke a model. Windows POSIX mode-bit assertions must be distinguished from a format change using the unmodified base; they must not be skipped, weakened, or presented as passing.

### Historical independently verified 4.8 source scope

The following retained results apply to Shell 4.8 with SDK 1.5.0, not the new 4.9 candidate. An isolated snapshot with unchanged project configuration passed four native dependency/environment contracts, 17 selected daemon cases (57 other cases filtered), and a daemon TypeScript check after building its protocol reference. Both fake-loopback model/MCP approval-engine cases executed successfully. No correction, assertion change or deadline extension was needed.

The compiler resolved `ws` through the real `@types/ws` 8.18.2 `index.d.mts`. Earlier TS7016/TS7006 findings did not reproduce in this snapshot; the earlier LSP server's cause and current state are not established. A parent post-run comparison found no drift in the 75 original/snapshot source inputs.

These are source-level results, not a full-suite, frozen-pnpm-install or installed-runtime certification. Tests use synthetic auth data and fake loopback services, never real credentials or providers.

### Historical 4.8 NaN streaming characterization

`packages/daemon/test/nan-provider.test.ts` exercised the real Shell 4.8 provider factory with SDK 1.5.0's extension-loader compatibility view. Four cases covered `stream` and `streamSimple`, each with a normal stop and fragmented tool arguments. The transport was an in-memory SSE response, not an external provider. Assertions checked the request, text events, final text and tool arguments, stop reason, one transport call, and zero discovery or ambient-fetch calls.

The four streaming cases and six authentication cases passed with the daemon typecheck. Eleven earlier configuration, profile and SDK-approval cases also passed: 21 selected cases across two runs, not one full-suite run. A parent post-run check verified all 76 original/snapshot source inputs against their preparation hashes with zero drift. That characterization is not a new independent-verifier verdict and has not been rerun as 4.9 evidence.

Full Shell launcher operation and packaged/installed 4.9 operation remain unverified. Process-local fetch mocks do not establish egress containment for launcher descendants. Dependency resolution, candidate runtime packaging, the paused producer environment gap and the pinned Gentle AI helper remain separate checks. The published 4.9 package's host preflight deadline is also a separate Shell correction; this version change does not fix or bypass it in the currently running Shell.
