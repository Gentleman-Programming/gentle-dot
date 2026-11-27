// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "windows-split-runtime", not(all(windows, target_arch = "x86_64"))))]
compile_error!("windows-split-runtime requires a Windows x64 target");

#[cfg(all(feature = "windows-split-runtime", feature = "local-preview"))]
compile_error!("windows-split-runtime is incompatible with local-preview");

#[cfg(all(feature = "windows-split-runtime", windows, target_arch = "x86_64"))]
mod windows_split_startup;

fn main() {
    #[cfg(all(feature = "windows-split-runtime", windows, target_arch = "x86_64"))]
    {
        use std::io::{self, Write};

        let refusal = windows_split_startup::startup_refusal();
        // The release GUI subsystem may have no attached stderr. Never persist this to disk.
        let _ = writeln!(io::stderr().lock(), "{}", refusal.diagnostic());
        std::process::exit(1);
    }

    #[cfg(not(feature = "windows-split-runtime"))]
    gentle_dot_lib::run();
}
