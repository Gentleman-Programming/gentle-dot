# Gentle Shell compatibility

Gentle Dot pins published Gentle Shell (`gentle-pi`) 5.0.0 with Pi SDK 1.6.0. Dot preserves its existing version-1 profile workflow metadata, introduced alongside Shell 4.7/4.8. This is not a new UI control, permission to enable delegation, or installed-engine certification.

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

The daemon dependency and pnpm lock select `gentle-pi` 5.0.0. [Official npm metadata](https://registry.npmjs.org/gentle-pi/5.0.0) identifies source commit `be74d44cec564fae3c9cc66f392d1396fd432fe8` and integrity `sha512-Fojxljdn2b6n4fTdT0UdLR519qEVByKC3CNmjCt3H8fhYpvkDqT7q9EPbZk0vYie2D8Ek6ZPVINslMeBm2qReA==`. The [upstream distribution manifest](https://github.com/Gentleman-Programming/gentle-shell/releases/download/v5.0.0/gentle-shell-distribution.json) pins [`@earendil-works/pi-coding-agent` 1.6.0](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.6.0) exactly; Dot matches that release across its direct SDK dependencies and lock-derived runtime sibling overrides. The Pi CLI entry remains `dist/bundle/cli.js`, and both packages declare support for Node.js 24. These are provenance and recipe checks, not verification of a downloaded runtime artifact.

Shell setup also requires package-local Gentle AI 5.0.0. Upstream pins signed Linux/macOS assets and a Windows Go source build. Dot’s existing staging recipe still needs to produce and validate that helper; matching the npm versions alone does not prove setup or establish that Dot needs the separate upstream prefix installer.

Dot continues to use the bundled `bin/gentle-shell.mjs` launcher and its RPC interface. Its existing protection removes an inherited `GENTLE_SHELL_INTERACTIVE_HOST` only after identifying Dot's own bundled default engine. Explicit `GENTLE_DOT_AGENT_BIN`, `GENTLE_DOT_AGENT_SCRIPT`, and `GENTLE_DOT_AGENT_ARGS` choices retain their environment. No launcher, environment-control or provisioning logic changes with this pin. This update does not introduce structured Desktop widgets, canvas, or permission controls; Dot's existing extension-dialog routing remains unchanged. Dot's explicitly selected Engram binary is not automatically upgraded by Shell's companion defaults.

On Windows, the default packaged launch uses the first absolute inherited directory containing `git.exe`. If none qualifies, Dot checks `Git\cmd` under Windows' native Program Files Known Folder, then the x86 Program Files Known Folder. It ignores inherited Program Files variables and appends at most one directory after the runtime and system entries. See [the Windows install notes](install.md) for the path restrictions. If no Git qualifies or Shell otherwise cannot verify Git tracking, Shell still skips automatic skill-registry writes. Dot neither forces a refresh nor repairs the registry or Git installation. This fallback does not establish what PATH the live child in a particular installation inherited.

## Verification boundaries

Run the dependency-selection contract without installing packages, compiling Go, or launching an engine:

```sh
node --test scripts/windows/test/gentle-shell-compatibility.test.mjs
```

It checks source and packaged-runtime lock selection, exact SDK/sibling consistency, inherited interactive-host refusal and custom/platform environment preservation. The 5.0.0/1.6.0 expectations fail with the old tuple and pass with the new lock. The workspace lock was regenerated with pnpm 11.5.0 and checked offline in frozen lockfile-only mode with scripts disabled. Neither check installs an engine. The `runtime-build.test.ts` suite builds runtime artifacts, has Windows native-addon prerequisites, and its project setup compiles the private-storage helper. Real SDK loopback tests and staged-runtime smoke checks are separate functional evidence; none may use personal profiles or real provider credentials.

Profile-format tests exercise synthetic files through the public profile store and format functions. They never migrate real user data or invoke a model. Windows POSIX mode-bit assertions must be distinguished from a format change using the unmodified base; they must not be skipped, weakened, or presented as passing.

### Historical independently verified 4.8 source scope

The following retained results apply to Shell 4.8 with SDK 1.5.0, not the 5.0.0 candidate. An isolated snapshot with unchanged project configuration passed four native dependency/environment contracts, 17 selected daemon cases (57 other cases filtered), and a daemon TypeScript check after building its protocol reference. Both fake-loopback model/MCP approval-engine cases executed successfully. No correction, assertion change or deadline extension was needed.

The compiler resolved `ws` through the real `@types/ws` 8.18.2 `index.d.mts`. Earlier TS7016/TS7006 findings did not reproduce in this snapshot; the earlier LSP server's cause and current state are not established. A parent post-run comparison found no drift in the 75 original/snapshot source inputs.

These are source-level results, not a full-suite, frozen-pnpm-install or installed-runtime certification. Tests use synthetic auth data and fake loopback services, never real credentials or providers.

### Historical 4.8 NaN streaming characterization

`packages/daemon/test/nan-provider.test.ts` exercised the real Shell 4.8 provider factory with SDK 1.5.0's extension-loader compatibility view. Four cases covered `stream` and `streamSimple`, each with a normal stop and fragmented tool arguments. The transport was an in-memory SSE response, not an external provider. Assertions checked the request, text events, final text and tool arguments, stop reason, one transport call, and zero discovery or ambient-fetch calls.

The four streaming cases and six authentication cases passed with the daemon typecheck. Eleven earlier configuration, profile and SDK-approval cases also passed: 21 selected cases across two runs, not one full-suite run. A parent post-run check verified all 76 original/snapshot source inputs against their preparation hashes with zero drift. That characterization is not a new independent-verifier verdict and has not been rerun as 5.0.0 evidence.

Full Shell launcher and packaged/installed 5.0.0 operation remain unverified. Process-local fetch mocks do not establish egress containment for launcher descendants. Runtime packaging and the pinned Gentle AI helper remain separate checks. The version pin does not change Git tracking checks or bypass Shell’s skill registry refresh guard.
