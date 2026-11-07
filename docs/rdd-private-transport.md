# Private RDD capture is retired

The optional Settings `debug` control, `--dot-rdd-debug` flag, private capture
broker and native diagnostic viewer are retired. There is no replacement capture
command, pipe or public-output fallback.

`dot_review_status` remains a status-only operation using the existing SDK resolver,
process options and engine environment. Its sanitized results and finite manual
failure guidance remain; see [RDD status guidance](windows-rdd-indicative-diagnostics.md).
Core approval, channel authentication, credential and audit infrastructure remain.

Existing stored debug keys, captures, logs and audit records are left untouched.
Other settings writes preserve unknown keys; an old debug value no longer enables
collection. No migration, reset, cleanup, build, installation or restart is performed.

Focused Node retirement checks establish source behavior and structural wiring only,
not native Windows operation or installed-app acceptance. The owner builds and verifies
using the existing daemon environment.
