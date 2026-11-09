//! Gentle Dot's Engram guard.
//!
//! The providers reach local Engram data only by running `ENGRAM_BIN`, so a program that refuses
//! to run is what stops them before any store is opened, created or migrated. The POSIX guard ships
//! as a `#!/bin/sh` script, which Windows has no interpreter for — that is why an installed or
//! dev-launched copy could not even report the refusal (issue #90's sibling: the notice said the
//! binary "could not be found" instead of saying memory was off). This is the same contract as a
//! real executable: one notice on stderr, exit `78` (`EX_CONFIG`), and nothing else — it never runs
//! Engram and never reads or writes Engram data.
//!
//! `ENGRAM_STARTUP_NOTICE` replaces the text, so a caller that knows the reason can say it.

use std::io::Write;

/// Printed when the caller does not supply `ENGRAM_STARTUP_NOTICE`.
const DEFAULT_NOTICE: &str = "Engram memory disabled: Gentle Dot could not start the Engram binary the environment names, so it will not open, create or migrate Engram data. Point ENGRAM_BIN at a working Engram (or unset it) and restart the app. No store was touched.";

/// `EX_CONFIG` from `sysexits.h`, the code the POSIX guard uses, so both refuse the same way.
const EX_CONFIG: i32 = 78;

fn notice() -> String {
    std::env::var("ENGRAM_STARTUP_NOTICE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_NOTICE.to_string())
}

fn main() {
    let mut stderr = std::io::stderr().lock();
    // A guard that panicked on a closed stderr would still have to refuse, so the write is ignored
    // and the exit code carries the decision.
    let _ = writeln!(stderr, "{}", notice());
    let _ = stderr.flush();
    std::process::exit(EX_CONFIG);
}
