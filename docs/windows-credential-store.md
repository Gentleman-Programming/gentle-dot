# Windows connector credential store

Windows selects a Credential Manager-backed `SecretStore`; it does not fall back to the in-memory test store. The implementation stores generic credentials under this app's service prefix, not in a plaintext secret file.

## Contract

- IDs are 1–200 bytes from the existing ASCII allowlist `[A-Za-z0-9._:@/-]`. Target names use `dev.gentleman.gentle-dot.connectors/<id>` and are converted to UTF-16 for the Windows API.
- Values are UTF-8 bytes in generic credential blobs with `CRED_PERSIST_LOCAL_MACHINE`. Values above 2,560 bytes return an explicit error; they are not truncated or sent to another backend. Empty values are accepted by `put`, but this Windows round-trip test does not explicitly exercise an empty value.
- Missing reads return `None`; deleting a missing item returns `false`. Access denied maps to `Denied`; other API errors map to `Unavailable`. Reads copy the blob before freeing the API allocation, reject invalid UTF-8 as `NotText`, and wipe the invalid copied bytes.
- Listing enumerates only the app service prefix, validates returned IDs, then sorts and deduplicates them. The Windows test uses a unique random ID and attempts deletion in a drop guard.

This is the current Windows logon's Credential Manager generic-credential interface; it is not a custom DPAPI file format. No backup/export behavior is promised. Source inspection is not proof of actual Credential Manager round trips or of a Windows user's broader security posture.

## Verification and rollback

- `rustfmt --check --config max_width=120,use_small_heuristics=Max,skip_children=true apps/desktop/src-tauri/src/secure_store/windows.rs apps/desktop/src-tauri/src/secure_store/mod.rs` — passed.
- `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -p windows-sys@0.61.2` — passed for the dependency API crate only; not the application backend.
- `git diff --check` — passed.
- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` — not run for W3: the existing environment lacks MSVC `link.exe`; no credential-store round-trip is claimed.

The source test `credential_manager_roundtrip_uses_only_a_unique_test_credential` covers a Unicode value, list, oversize rejection without replacing the previous value, deletion, and cleanup attempt. It was not executed. Runtime harness: N/A; no live Credential Manager operation was run. Rollback is the W3 unit in `apps/desktop/src-tauri/src/secure_store/windows.rs`, `apps/desktop/src-tauri/src/secure_store/mod.rs`, and this document; consider consumers before reverting it.
