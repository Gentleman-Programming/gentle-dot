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

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
