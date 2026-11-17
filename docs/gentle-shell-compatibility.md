# Gentle Shell compatibility

Gentle Dot pins Gentle Shell (`gentle-pi`) 4.8.0 and preserves the version-1 profile workflow metadata shared by Gentle Shell 4.7 and 4.8 when managing model profiles. This is format compatibility, not a new UI control or permission to enable a delegation mode.

## Stored profiles

Gentle Shell keeps its version-1 profile format and may add:

```json
{
  "workflow": {
    "delegated": { "orchestratorMode": "full-delegation" }
  }
}
```

The name must identify a stored profile. Like the engine, Dot omits the default `organic` mode, invalid modes, and orphan workflow entries. Existing organic-only stores retain their previous shape.

Saving routes or applying another profile preserves existing workflow entries. Renaming or duplicating a profile carries its workflow metadata; deleting it removes that profile's entry. An import with identical routes but a different workflow mode is not an identical profile: it receives the normal collision suffix. Repeating that import does not duplicate it again or alter the source store.

## Packaged runtime

The daemon dependency and pnpm lockfile both select `gentle-pi` 4.8.0. The published package keeps the same dependencies and peer requirements as 4.7.0; its new integrity and Node engine range are recorded in the lockfile. Node.js 24 remains supported.

The existing Pi SDK 1.5.0 dependencies and matching runtime sibling overrides remain pinned. Upstream tests Shell 4.8 with Pi 1.5.2, but the declared coding-agent peer range remains `>=1.2.0`; updating the whole SDK is not implicit in this change.

Dot continues to use the bundled `bin/gentle-shell.mjs` launcher and its RPC interface. Shell 4.8's interactive RPC host is opt-in. Dot removes an inherited `GENTLE_SHELL_INTERACTIVE_HOST` only after identifying its own bundled default engine, so a parent shell cannot implicitly enable the new host mode. Explicit `GENTLE_DOT_AGENT_BIN`, `GENTLE_DOT_AGENT_SCRIPT`, and `GENTLE_DOT_AGENT_ARGS` choices retain their environment. This update does not introduce structured Desktop widgets, canvas, or permission controls; Dot's existing extension-dialog routing remains unchanged. Existing no-auto-setup and installed-runtime provisioning guards remain separate from the version pin. Dot's explicitly selected Engram binary is not automatically upgraded by Shell's companion defaults.

## Verification boundaries

Run the dependency-selection contract without installing packages, compiling Go, or launching an engine:

```sh
node --test scripts/windows/test/gentle-shell-compatibility.test.mjs
```

It checks both source and packaged-runtime lock selection, plus exact SDK/sibling consistency. It does not prove an installed engine works. The existing `runtime-build.test.ts` expectations also select 4.8.0, but that suite builds runtime artifacts, has Windows native-addon prerequisites, and its project setup compiles the private-storage helper. Real SDK loopback tests and staged-runtime smoke checks are separate functional evidence; none may use personal profiles or real provider credentials.

Profile-format tests exercise synthetic files through the public profile store and format functions. They never migrate real user data or invoke a model. Windows POSIX mode-bit assertions must be distinguished from this format change using the unmodified base; they must not be skipped, weakened, or presented as passing.

### Independently verified source scope

An isolated snapshot with unchanged project configuration and SDK 1.5.0 passed four native dependency/environment contracts, 17 selected daemon cases (57 other cases filtered), and a daemon TypeScript check after building its protocol reference. Both fake-loopback model/MCP approval-engine cases executed successfully. No correction, assertion change or deadline extension was needed.

The compiler resolved `ws` through the real `@types/ws` 8.18.2 `index.d.mts`. Earlier TS7016/TS7006 findings did not reproduce in this snapshot; the earlier LSP server's cause and current state are not established. A parent post-run comparison found no drift in the 75 original/snapshot source inputs.

These are source-level results, not a full-suite, frozen-pnpm-install or installed-runtime certification. Full Shell launcher operation, NaN streaming and packaged/installed 4.8 operation remain separate functional checks. Tests use synthetic auth data and fake loopback services, never real credentials or providers.

Dependency resolution, candidate runtime packaging and the pinned Gentle AI helper remain separate checks. A dependency version change alone does not establish runtime compatibility.
