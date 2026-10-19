# Third-party notices

## wlroots-bridge (reference only, MIT)

The Linux/Wayland design in `src/computer/linux/` was guided by the registry
sweep shape, interface names, and bind-version choices of `wlroots-bridge`
(a Wayland support bridge for Linux computer-use tooling), which is used as a
read-only reference — no code is vendored and no runtime dependency is taken.
The output enumeration (`src/computer/linux/outputs.rs`) additionally follows
the per-output accumulator shape of its `screens.rs`/`conn.rs` and the idea of
a fractional scale derived from hardware mode size over logical size, with
these deliberate divergences: every wait is bounded by the sweep's total
deadline and cooperative cancel handle instead of blocking `roundtrip`s;
rotation stays inside the validated `OutputGeometry` mapping instead of an
untransformed screen shape; and the sweep never synthesizes a primary output,
a fallback display name, a cursor position, or a compositor guess.

The frame capture (`src/computer/linux/capture.rs`) and pixel decoding
(`src/computer/linux/pixels.rs`) additionally follow the
`wlr-screencopy-unstable-v1` request/event order (`capture_output`, `buffer`
/ `buffer_done`, `copy`, `flags` / `ready` / `failed`, overlay cursor
excluded) and the little-endian channel maps of its `decode_shm`, with
these deliberate divergences: every wait is deadline/cancel bounded through
the shared transport helpers instead of blocking `roundtrip`s; frame
dimensions must equal the validated `OutputGeometry` instead of remapping;
allocation is refused past an explicit memory cap before the SHM fd exists;
the pool file is read back with safe `File` reads (no `mmap`); decoding
targets packed BGRA so the established `encode.rs` JPEG path is reused; and
there is no cursor sampling, primary-output or front-app claim.

The pointer actions (`src/computer/linux/pointer.rs`) follow the
`wlr-virtual-pointer-unstable-v1` request shape (`motion_absolute` with
extents, `button` with evdev codes, `axis` with 15-unit notches, `frame`)
and the output-bound mapping of Niri's `src/protocols/virtual_pointer.rs`
(device output from `create_virtual_pointer_with_output`, normalized
position mapped through `compute_absolute_location` in `src/input/mod.rs`),
with these deliberate divergences: the device is always created bound to the
caller-selected output with selected-output logical coordinates and extents
(never the reference's union bounding box, never clamped; a v1 manager
fails closed instead of guessing); each operation consumes its own
`Connection` and closes it on return, with a scope guard that releases only
its own held button and explicitly destroys the device, its manager and
(v3+) the output on every exit — so the destructor-less registry can never
accumulate on a shared connection (no forked holder process, no pidfile, no
held input across operations); and every wait, pause and the confirming
`sync` barrier is deadline/cancel bounded instead of blocking `roundtrip`s.
Whether a closed connection releases a stuck button server-side is
compositor-defined and unproven here, so the client always sends release
before destroy itself and never relies on server-side cleanup.

- Protocol spec: `wlr-screencopy-unstable-v1.xml` (wayland-protocols-wlr)
- License: MIT, Copyright (c) 2018 Simon Ser, Copyright (c) 2019 Andri Yngvason

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice (including the next
> paragraph) shall be included in all copies or substantial portions of the
> Software.

- Upstream: `/home/jona/mnt/sv-home/dev/upstream/wlroots-bridge`
- License: MIT, Copyright (c) 2026 Patrick Jaja

The keyboard input (`src/computer/linux/keyboard.rs` and `src/computer/linux/keymap.rs`)
additionally follows the `zwp_virtual_keyboard_v1` request shape (`keymap` with an
anonymous memfd, `format` 1, NUL-terminated `size`; `key` with evdev codes) and the
hand-rolled XKB keymap-text technique of the same reference (sequential keycodes
from 9, four modifiers first, `modifier_map` entries, Unicode keysyms as
`0x01000000 | codepoint`), with these deliberate divergences: no xkeysym or
libxkbcommon dependency (ASCII letters/digits spell themselves, punctuation goes
through a fixed XKB name table, the rest uses `U` escapes); every keysym is bound
at level 1 so Shift is never synthesized; the keymap upload is memfd-only with no
filesystem fallback; each operation consumes its own `Connection` with a scope
guard that releases only its own keys plus an explicit keyboard destroy and (v5+)
seat release — the v1 manager has no destructor, so none is fabricated and the
connection close frees it; Mac `cmd` drives Super while `fn` fails closed; and
every wait, pause and the confirming `sync` barrier is deadline/cancel bounded
instead of blocking `roundtrip`s. Unit tests validate the keymap structure;
separate verification compiled six generated maps with libxkbcommon 1.13.2.
Real-compositor keyboard input has not been verified.

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
