//! Portable location and safe write path for the app-managed Niri snippet.
//!
//! Linux/Niri only in practice, but the code itself is plain `std`: it never
//! reads the environment through globals, never hardcodes a home directory or a
//! distro layout, and takes every side effect through [`ConfigIo`] so the exact
//! production order is testable with a fake. Rules that keep it safe on any
//! user's machine:
//!
//! * the app owns ONE snippet file and ONE `include` line; nothing else in the
//!   user's config is ever rewritten;
//! * every write is preceded by a byte backup and followed by a validation
//!   call, and a failed validation restores the backup;
//! * an already-correct config is left untouched (no write, no reload).

use crate::niri::kdl_binds;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Niri's config directory, honouring `NIRI_CONFIG` (a config file path),
/// `XDG_CONFIG_HOME` and `HOME` in that order. `None` when nothing identifies a
/// home, so callers never invent a path.
pub fn niri_config_dir(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(file) = env("NIRI_CONFIG").filter(|value| !value.is_empty()) {
        return PathBuf::from(file).parent().map(Path::to_path_buf);
    }
    if let Some(base) = env("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(base).join("niri"));
    }
    env("HOME")
        .filter(|value| !value.is_empty())
        .map(|home| PathBuf::from(home).join(".config").join("niri"))
}

/// The two files this module manages. `config_file` is only ever appended to;
/// `snippet` is owned outright by the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub config_file: PathBuf,
    pub snippet: PathBuf,
}

impl Manifest {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            config_file: config_dir.join("config.kdl"),
            snippet: config_dir.join(kdl_binds::SNIPPET_STEM),
        }
    }

    /// Manifest for an explicit config file (keeps a custom NIRI_CONFIG name):
    /// the snippet stays a sibling so a bare relative include still resolves.
    pub fn from_config_file(config_file: &Path) -> Self {
        let snippet = match config_file.file_name() {
            Some(_) => config_file.with_file_name(kdl_binds::SNIPPET_STEM),
            None => config_file.join(kdl_binds::SNIPPET_STEM),
        };
        Self { config_file: config_file.to_path_buf(), snippet }
    }
}

/// The config file itself, honouring a custom NIRI_CONFIG filename instead
/// of assuming `config.kdl`.
pub fn niri_config_file(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(file) = env("NIRI_CONFIG").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(file));
    }
    niri_config_dir(env).map(|dir| dir.join("config.kdl"))
}

/// What a first run must do, decided from text alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Already included and already binding: nothing to write.
    Ready,
    /// Included, but the snippet does not bind the toggle yet.
    AddBinding,
    /// Not included yet: append the include line and write the snippet.
    CreateAndInclude,
}

/// First-run decision: pure over the config text plus whether the snippet file
/// exists, so the whole matrix is pinned without touching a filesystem. The
/// verb (`arg`) is the caller's: the toggle and the fullscreen binding share the
/// same repair, they never share a line.
pub fn plan_first_run(config_text: &str, snippet_exists: bool, snippet_text: &str, arg: &str) -> Plan {
    let bound = snippet_exists && kdl_binds::bound_key(snippet_text, arg).is_some();
    if !kdl_binds::includes_snippet(config_text) {
        Plan::CreateAndInclude
    } else if bound {
        Plan::Ready
    } else {
        Plan::AddBinding
    }
}

/// Config text plus the include line when it is missing; `None` when the include
/// is already there, so a caller can skip the write entirely.
pub fn with_include(config_text: &str) -> Option<String> {
    if kdl_binds::includes_snippet(config_text) {
        return None;
    }
    let mut text = config_text.to_owned();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&kdl_binds::include_line());
    text.push('\n');
    Some(text)
}

/// The infix that marks a backup sibling: `<name>.gd-backup-<stamp>`.
pub const BACKUP_INFIX: &str = ".gd-backup-";

/// How many backups of one file are kept. Every write leaves one and nothing else removes them, so
/// without a limit a long series of writes fills the folder.
pub const BACKUPS_KEPT: usize = 3;

/// Backup path for `path`: sibling file carrying the caller's stamp, so a
/// timestamp never has to live in this module.
pub fn backup_path(path: &Path, stamp: &str) -> PathBuf {
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(format!("{BACKUP_INFIX}{stamp}"));
    path.with_file_name(name)
}

/// Every side effect this module needs, so tests drive the production order
/// with a fake instead of a real home directory.
pub trait ConfigIo {
    fn read(&mut self, path: &Path) -> io::Result<String>;
    fn write(&mut self, path: &Path, text: &str) -> io::Result<()>;
    fn copy(&mut self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove(&mut self, path: &Path) -> io::Result<()>;
    /// Validate the named config file with Niri's own checker.
    fn validate(&mut self, config_file: &Path) -> io::Result<()>;
    /// Validate a staged (not yet published) candidate before any live write.
    /// The default accepts; the real I/O stages both files in a temp dir so
    /// Niri never auto-reloads a half-published pair.
    fn validate_candidate(&mut self, _config_text: &str, _snippet_text: &str, _config_file: &Path) -> io::Result<()> {
        Ok(())
    }
    /// The siblings of `path` in its folder, as far as the implementation can see. The default finds
    /// none, so an implementation that does not care about pruning keeps working.
    fn siblings(&mut self, _path: &Path) -> io::Result<Vec<PathBuf>> {
        Ok(Vec::new())
    }
    /// When `path` last changed, when the filesystem offers a time. The default has none.
    fn modified(&mut self, _path: &Path) -> io::Result<Option<SystemTime>> {
        Ok(None)
    }
}

/// What a first run actually changed, for the caller's log and result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub wrote_snippet: bool,
    pub wrote_include: bool,
    pub backup: Option<&'static str>,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Serializes the settings and first-run writers in this process so two
/// concurrent toggles cannot interleave backup/write/validate steps.
/// Cross-process races rely on unique backups plus atomic renames.
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The snippet text. A missing file is an absent snippet; any other read
/// error propagates instead of reading as empty.
fn read_snippet(io: &mut impl ConfigIo, snippet: &Path) -> io::Result<String> {
    match io.read(snippet) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error),
    }
}

/// Undo one published file: restore its bytes when backed up, otherwise
/// remove what the failed pass created (absence is correct, never an error).
fn restore(io: &mut impl ConfigIo, backup: &Path, live: &Path, had_backup: bool) -> io::Result<()> {
    if had_backup {
        return io.copy(backup, live);
    }
    match io.remove(live) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Back up `live` unless it does not exist yet (never invent a backup).
fn backup(io: &mut impl ConfigIo, live: &Path, stamp: &str) -> io::Result<(PathBuf, bool)> {
    let backup = backup_path(live, stamp);
    match io.copy(live, &backup) {
        Ok(()) => Ok((backup, true)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok((backup, false)),
        Err(error) => Err(error),
    }
}

/// Removes the backups of `live` beyond the newest [`BACKUPS_KEPT`]. It runs only after a write was
/// validated, and keeps the newest ones: the backup of an in-flight write is the newest of all, so a
/// concurrent writer never loses bytes it could still have to restore. Best effort by design, so a
/// folder that cannot be tidied never fails a write that already succeeded.
fn prune_backups(io: &mut impl ConfigIo, live: &Path) {
    let Ok(siblings) = io.siblings(live) else {
        return;
    };
    let mut backups: Vec<(Option<SystemTime>, PathBuf)> =
        siblings.into_iter().map(|path| (io.modified(&path).ok().flatten(), path)).collect();
    if backups.len() <= BACKUPS_KEPT {
        return;
    }
    // Newest first; an undated file sorts last, so a dated one is kept before it.
    backups.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, path) in backups.into_iter().skip(BACKUPS_KEPT) {
        let _ = io.remove(&path);
    }
}

/// Owned-snippet heal: decorations off plus never-focus-on-map, so one call
/// heals both and a second pass is a no-op. Pure text, invents no block.
fn heal_snippet(text: &str) -> String {
    kdl_binds::ensure_open_focused_off(&kdl_binds::ensure_decorations_off(text))
}

/// Map a checked-upsert refusal into the settings/startup error channel.
/// The legacy total helper is no longer used on these paths: an unsupported
/// multiline layout is a hard error with files untouched, never a silent
/// keep-or-duplicate.
fn upsert_failed(error: kdl_binds::UpsertError) -> io::Error {
    match error {
        kdl_binds::UpsertError::UnsupportedLayout => {
            invalid("niri: snippet has an unsupported multiline binding; merge it by hand")
        }
    }
}

/// Publish one snippet candidate through the staged gate plus backup and
/// live validation, restoring the previous bytes on refusal. Shared by the
/// binding repair and the decoration-only repair so both get the same
/// safety: backup, staged candidate first, publish, live validate, restore.
fn publish_snippet(
    io: &mut impl ConfigIo,
    manifest: &Manifest,
    config_text: &str,
    next: &str,
    stamp: &str,
    report: &mut Report,
) -> io::Result<()> {
    io.validate_candidate(config_text, next, &manifest.config_file)?;
    let (snippet_backup, had_snippet) = backup(io, &manifest.snippet, stamp)?;
    if had_snippet {
        report.backup = Some("snippet");
    }
    if let Err(error) = (|| -> io::Result<()> {
        io.write(&manifest.snippet, next)?;
        io.validate(&manifest.config_file)?;
        Ok(())
    })() {
        // A failed restore must stay visible: report it alongside the
        // publish error instead of discarding it, without touching the
        // success path or the backup/write/validate order.
        match restore(io, &snippet_backup, &manifest.snippet, had_snippet) {
            Ok(()) => return Err(error),
            Err(restore_error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("{error}; niri: restore after failed publish also failed: {restore_error}"),
                ));
            }
        }
    }
    report.wrote_snippet = true;
    prune_backups(io, &manifest.snippet);
    Ok(())
}

/// First-run repair: make `config.kdl` include the snippet and make the snippet
/// bind `arg` (toggle or fullscreen), backing up and validating every file it
/// touches and restoring the backup when validation refuses the result.
/// Idempotent: on a ready config it performs no write at all. The toggle and
/// the fullscreen binding each get their own pass, so one never erases the other.
pub fn first_run(
    io: &mut impl ConfigIo,
    manifest: &Manifest,
    executable: &str,
    stamp: &str,
    arg: &str,
    key: &str,
) -> io::Result<Report> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let config_text = io.read(&manifest.config_file)?;
    let snippet_text = read_snippet(io, &manifest.snippet)?;
    let snippet_exists = !snippet_text.is_empty();
    let mut report = Report { wrote_snippet: false, wrote_include: false, backup: None };
    match plan_first_run(&config_text, snippet_exists, &snippet_text, arg) {
        Plan::Ready => {
            // Binding already correct: the only remaining repair is the
            // compositor-decoration lines inside our own window-rule blocks.
            // Already-correct text returns byte-identical, so no write runs.
            let next = heal_snippet(&snippet_text);
            if next == snippet_text {
                return Ok(report);
            }
            publish_snippet(io, manifest, &config_text, &next, stamp, &mut report)?;
        }
        Plan::AddBinding => {
            let next = kdl_binds::try_upsert_binding(&snippet_text, executable, arg, key).map_err(upsert_failed)?;
            // Same repair transaction also disables the compositor outline
            // for our own windows, so an existing install heals without
            // hand editing. Never invents a block it does not already match.
            let next = heal_snippet(&next);
            publish_snippet(io, manifest, &config_text, &next, stamp, &mut report)?;
        }
        Plan::CreateAndInclude => {
            let Some(next_config) = with_include(&config_text) else {
                return Err(invalid("niri: include plan without a change"));
            };
            let next_snippet =
                kdl_binds::try_upsert_binding(&snippet_text, executable, arg, key).map_err(upsert_failed)?;
            let next_snippet = heal_snippet(&next_snippet);
            io.validate_candidate(&next_config, &next_snippet, &manifest.config_file)?;
            let config_backup = backup_path(&manifest.config_file, stamp);
            io.copy(&manifest.config_file, &config_backup)?;
            report.backup = Some("config");
            let (snippet_backup, had_snippet) = match backup(io, &manifest.snippet, stamp) {
                Ok(pair) => pair,
                Err(error) => {
                    let _ = io.copy(&config_backup, &manifest.config_file);
                    return Err(error);
                }
            };
            // Snippet first: a config that includes a missing snippet is an
            // error state, while an unincluded snippet is inert.
            if let Err(error) = (|| -> io::Result<()> {
                io.write(&manifest.snippet, &next_snippet)?;
                io.write(&manifest.config_file, &next_config)?;
                io.validate(&manifest.config_file)?;
                Ok(())
            })() {
                let snippet_restored = restore(io, &snippet_backup, &manifest.snippet, had_snippet);
                let config_restored = io.copy(&config_backup, &manifest.config_file);
                let mut detail = Vec::new();
                if let Err(restore_error) = snippet_restored {
                    detail.push(format!("snippet restore failed: {restore_error}"));
                }
                if let Err(restore_error) = config_restored {
                    detail.push(format!("config restore failed: {restore_error}"));
                }
                if detail.is_empty() {
                    return Err(error);
                }
                return Err(io::Error::new(error.kind(), format!("{error}; {}", detail.join("; "))));
            }
            report.wrote_snippet = true;
            report.wrote_include = true;
            prune_backups(io, &manifest.snippet);
            prune_backups(io, &manifest.config_file);
        }
    }
    Ok(report)
}

/// Staged-root rewrite (B1): the staged root resolves every include to a
/// file that exists at gate time, so the candidate gate validates exactly
/// what publication would activate:
/// * the app-owned snippet include (bare stem, relative, or absolute) always
///   points at the staged candidate snippet;
/// * any other relative include resolves against the ORIGINAL config parent
///   (absolute), so nested includes keep their original parents;
/// * any other absolute or `~` include stays byte-identical;
/// * non-include lines (comments included) stay byte-identical.
/// A line that claims `include` without a quoted path fails closed: staging
/// must never silently validate different bytes than publication.
pub(crate) fn rewrite_staged_root(
    config_text: &str,
    staged_snippet: &Path,
    original_parent: &Path,
) -> io::Result<String> {
    let staged = staged_snippet
        .to_str()
        .ok_or_else(|| invalid("niri: staged snippet path is not utf-8"))?;
    let mut out = String::with_capacity(config_text.len());
    for line in config_text.lines() {
        match kdl_binds::include_path(line) {
            None => {
                out.push_str(line);
                out.push('\n');
            }
            Some(target) => {
                if kdl_binds::is_owned_include(&target) {
                    let rewritten = kdl_binds::rewrite_include_path(line, staged)
                        .ok_or_else(|| invalid("niri: staged include without a quoted path"))?;
                    out.push_str(&rewritten);
                    out.push('\n');
                } else if target.starts_with('~') || std::path::Path::new(&target).is_absolute() {
                    out.push_str(line);
                    out.push('\n');
                } else {
                    let absolute = original_parent.join(&target);
                    let absolute = absolute
                        .to_str()
                        .ok_or_else(|| invalid("niri: staged include path is not utf-8"))?;
                    let rewritten = kdl_binds::rewrite_include_path(line, absolute)
                        .ok_or_else(|| invalid("niri: staged include without a quoted path"))?;
                    out.push_str(&rewritten);
                    out.push('\n');
                }
            }
        }
    }
    Ok(out)
}

/// Run one validator binary against a config file; a refusal maps to
/// `InvalidData`, never to a silent pass.
pub(crate) fn run_validator(program: &str, config_file: &Path) -> io::Result<()> {
    let output = std::process::Command::new(program)
        .arg("validate")
        .arg("--config")
        .arg(config_file)
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    let reason = String::from_utf8_lossy(&output.stderr);
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!("niri validate refused the config: {}", reason.trim()),
    ))
}

/// Real filesystem plus Niri's own checker. Writes go through a same-directory
/// temporary file and a rename, so a crash never leaves a half-written config,
/// and validation runs the compositor's own binary so an invalid candidate is
/// refused before it can reach a session.
pub struct RealConfigIo;

impl ConfigIo for RealConfigIo {
    fn read(&mut self, path: &Path) -> io::Result<String> {
        std::fs::read_to_string(path)
    }

    fn write(&mut self, path: &Path, text: &str) -> io::Result<()> {
        let temp = path.with_extension("kdl.gd-tmp");
        std::fs::write(&temp, text)?;
        std::fs::rename(&temp, path)
    }

    fn copy(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::copy(from, to).map(|_| ())
    }

    fn remove(&mut self, path: &Path) -> io::Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// The folder's backups of `path`, found by name so nothing else is ever touched.
    fn siblings(&mut self, path: &Path) -> io::Result<Vec<PathBuf>> {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return Ok(Vec::new());
        };
        let prefix = format!("{name}{BACKUP_INFIX}");
        let parent = path.parent().unwrap_or_else(|| Path::new(""));
        let entries = match std::fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(prefix.as_str()) {
                found.push(entry.path());
            }
        }
        Ok(found)
    }

    fn modified(&mut self, path: &Path) -> io::Result<Option<SystemTime>> {
        Ok(std::fs::metadata(path)?.modified().ok())
    }

    /// Stage both candidates in a temp dir and validate there, so the live
    /// files (which Niri auto-reloads) are only published after the gate.
    /// The staged root rewrites owned/sibling includes to gate-time files
    /// (see [`rewrite_staged_root`]); anything unresolvable refuses here,
    /// never as a live publish.
    fn validate_candidate(&mut self, config_text: &str, snippet_text: &str, config_file: &Path) -> io::Result<()> {
        let stage = std::env::temp_dir().join(format!("gd-niri-stage-{}", stamp()));
        std::fs::create_dir_all(&stage)?;
        let result = (|| -> io::Result<()> {
            let staged_snippet = stage.join(kdl_binds::SNIPPET_STEM);
            std::fs::write(&staged_snippet, snippet_text)?;
            let parent = config_file.parent().unwrap_or_else(|| Path::new(""));
            let staged_root = rewrite_staged_root(config_text, &staged_snippet, parent)?;
            std::fs::write(stage.join("config.kdl"), staged_root)?;
            self.validate(&stage.join("config.kdl"))
        })();
        let _ = std::fs::remove_dir_all(&stage);
        result
    }

    fn validate(&mut self, config_file: &Path) -> io::Result<()> {
        run_validator("niri", config_file)
    }
}

/// The toggle binding the snippet really has, if the Niri config file
/// resolves and the snippet binds it. `None` means "unknown" and callers must
/// fall back — never a fabricated key.
pub fn read_toggle_binding() -> Option<String> {
    let config_file = niri_config_file(|key| std::env::var(key).ok())?;
    let manifest = Manifest::from_config_file(&config_file);
    effective_toggle_binding(
        &std::fs::read_to_string(&manifest.config_file).ok()?,
        &std::fs::read_to_string(&manifest.snippet).ok()?,
    )
}

/// The effective toggle binding: the snippet's key only when the live config
/// actually includes the snippet. An unreferenced snippet binds nothing, so
/// `None` reads unknown instead of a key the compositor never sees.
fn effective_toggle_binding(config_text: &str, snippet_text: &str) -> Option<String> {
    if !kdl_binds::includes_snippet(config_text) {
        return None;
    }
    kdl_binds::bound_key(snippet_text, kdl_binds::TOGGLE_ARG)
}

/// Toggle writer over injected I/O (S19): maps the accelerator, ensures the
/// include line as well as the binding (an unreferenced snippet is a false
/// success), stages before publishing, and restores bytes/absence on refusal.
fn apply_toggle(
    io: &mut impl ConfigIo,
    manifest: &Manifest,
    executable: &str,
    stamp: &str,
    accelerator: &str,
) -> io::Result<String> {
    // Pure mapping first: an impossible accelerator fails before any I/O.
    let key = kdl_binds::niri_key(accelerator)
        .ok_or_else(|| invalid("niri: this accelerator has no Niri spelling"))?;
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let config_text = io.read(&manifest.config_file).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            invalid("niri: no Niri config to attach the snippet to")
        } else {
            error
        }
    })?;
    let snippet_text = read_snippet(io, &manifest.snippet)?;
    let next_snippet = kdl_binds::try_upsert_binding(&snippet_text, executable, kdl_binds::TOGGLE_ARG, &key)
        .map_err(upsert_failed)?;
    let next_snippet = heal_snippet(&next_snippet);
    let next_config = with_include(&config_text);
    let needs_include = next_config.is_some();
    if !needs_include && next_snippet == snippet_text && !snippet_text.is_empty() {
        return Ok(key);
    }
    let staged_config = next_config.as_deref().unwrap_or(&config_text);
    io.validate_candidate(staged_config, &next_snippet, &manifest.config_file)?;
    let (snippet_backup, had_snippet) = backup(io, &manifest.snippet, stamp)?;
    let config_backup = backup_path(&manifest.config_file, stamp);
    if needs_include {
        io.copy(&manifest.config_file, &config_backup)?;
    }
    if let Err(error) = (|| -> io::Result<()> {
        io.write(&manifest.snippet, &next_snippet)?;
        if let Some(staged) = next_config.as_deref() {
            io.write(&manifest.config_file, staged)?;
        }
        io.validate(&manifest.config_file)?;
        Ok(())
    })() {
        let snippet_restored = restore(io, &snippet_backup, &manifest.snippet, had_snippet);
        let config_restored = if needs_include {
            io.copy(&config_backup, &manifest.config_file).err()
        } else {
            None
        };
        let mut detail = Vec::new();
        if let Err(restore_error) = snippet_restored {
            detail.push(format!("snippet restore failed: {restore_error}"));
        }
        if let Some(restore_error) = config_restored {
            detail.push(format!("config restore failed: {restore_error}"));
        }
        if detail.is_empty() {
            return Err(error);
        }
        return Err(io::Error::new(error.kind(), format!("{error}; {}", detail.join("; "))));
    }
    prune_backups(io, &manifest.snippet);
    if needs_include {
        prune_backups(io, &manifest.config_file);
    }
    Ok(key)
}

/// Sets the toggle binding from the user's accelerator spelling (S19): maps it
/// to Niri's dialect, ensures the include, upserts only our own line, backs up
/// and validates, and restores the backup on refusal. Returns the Niri spelling
/// that landed, so Settings can show exactly what the compositor will see.
/// An already-correct snippet performs no write at all.
pub fn write_toggle_binding(accelerator: &str) -> io::Result<String> {
    let config_file = niri_config_file(|key| std::env::var(key).ok())
        .ok_or_else(|| invalid("niri: no config directory to manage"))?;
    let manifest = Manifest::from_config_file(&config_file);
    let executable = std::env::current_exe()
        .ok()
        .and_then(|path| path.into_os_string().into_string().ok())
        .ok_or_else(|| invalid("niri: executable path is not utf-8"))?;
    apply_toggle(&mut RealConfigIo, &manifest, &executable, &stamp(), accelerator)
}
/// Backup stamp: seconds + nanoseconds + pid + sequence, so concurrent writes
/// never share a backup name and repeated runs never collide with an old one.
fn stamp() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => format!(
            "{}-{:09}-{}-{seq}",
            elapsed.as_secs(),
            elapsed.subsec_nanos(),
            std::process::id()
        ),
        Err(_) => format!("0-0-{}-{seq}", std::process::id()),
    }
}

/// Production entry point: resolve THIS user's Niri config, then make the
/// snippet include plus the OPEN/CLOSE toggle binding real — and nothing else.
/// Every path comes from the environment and the running executable, so a
/// package install, a source build and another distro's layout all work
/// without a hardcoded location.
pub fn ensure_first_run() -> io::Result<Report> {
    let config_file = niri_config_file(|key| std::env::var(key).ok())
        .ok_or_else(|| invalid("niri: no config directory to manage"))?;
    let executable = std::env::current_exe()?;
    let executable = executable
        .to_str()
        .ok_or_else(|| invalid("niri: executable path is not utf-8"))?;
    let manifest = Manifest::from_config_file(&config_file);
    first_run(&mut RealConfigIo, &manifest, executable, &stamp(), kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const CONFIG: &str = "binds {\n    Mod+Q { close-window; }\n}\n";
    const SNIPPET: &str = "binds {\n    Mod+Alt+D { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n}\n";
    const EXE: &str = "/usr/bin/gentle-dot";

    struct Fake {
        files: HashMap<PathBuf, String>,
        times: HashMap<PathBuf, u64>,
        written: Vec<PathBuf>,
        validated: Vec<PathBuf>,
        events: Vec<&'static str>,
        fail_validate: bool,
        fail_candidate: bool,
        fail_snippet_read: bool,
        fail_restore_copy: bool,
    }

    impl Fake {
        fn new(files: &[(&str, &str)]) -> Self {
            Self {
                files: files.iter().map(|(path, text)| (PathBuf::from(path), (*text).to_owned())).collect(),
                times: HashMap::new(),
                written: Vec::new(),
                validated: Vec::new(),
                events: Vec::new(),
                fail_validate: false,
                fail_candidate: false,
                fail_snippet_read: false,
                fail_restore_copy: false,
            }
        }
    }

    impl Fake {
        /// Gives the named files a modification time, which is what pruning orders by.
        fn at(mut self, times: &[(&str, u64)]) -> Self {
            self.times = times.iter().map(|(path, at)| (PathBuf::from(path), *at)).collect();
            self
        }

        /// The backups of `live` still on disk, by stamp.
        fn backups_of(&self, live: &Path) -> Vec<String> {
            let prefix = format!("{}{BACKUP_INFIX}", live.file_name().unwrap().to_string_lossy());
            let mut stamps: Vec<String> = self
                .files
                .keys()
                .filter(|path| path.parent() == live.parent())
                .filter_map(|path| path.file_name()?.to_str()?.strip_prefix(&prefix).map(str::to_owned))
                .collect();
            stamps.sort();
            stamps
        }
    }

    impl ConfigIo for Fake {
        fn read(&mut self, path: &Path) -> io::Result<String> {
            if self.fail_snippet_read && path.ends_with(kdl_binds::SNIPPET_STEM) {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
            }
            self.files
                .get(path)
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "missing"))
        }
        fn write(&mut self, path: &Path, text: &str) -> io::Result<()> {
            self.events.push("write");
            self.written.push(path.to_path_buf());
            self.files.insert(path.to_path_buf(), text.to_owned());
            Ok(())
        }
        fn copy(&mut self, from: &Path, to: &Path) -> io::Result<()> {
            // A restore copies backup bytes back to the live file (the
            // source name carries the backup stamp); backups copy live
            // bytes out and must keep working so the test reaches the
            // restore path.
            if self.fail_restore_copy
                && from.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.contains(".gd-backup-"))
            {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "restore denied"));
            }
            let text = self.read(from)?;
            // A real copy lands now, so the newest backup is always the one just written.
            let next = self.times.values().max().copied().unwrap_or(0) + 1;
            self.times.insert(to.to_path_buf(), next);
            self.files.insert(to.to_path_buf(), text);
            Ok(())
        }
        fn remove(&mut self, path: &Path) -> io::Result<()> {
            self.files.remove(path).map(|_| ()).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "missing"))
        }
        fn validate(&mut self, config_file: &Path) -> io::Result<()> {
            self.events.push("validate");
            self.validated.push(config_file.to_path_buf());
            if self.fail_validate {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "niri: config invalid"));
            }
            Ok(())
        }
        fn siblings(&mut self, path: &Path) -> io::Result<Vec<PathBuf>> {
            let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
            let prefix = format!("{name}{BACKUP_INFIX}");
            Ok(self
                .files
                .keys()
                .filter(|sibling| sibling.parent() == path.parent())
                .filter(|sibling| {
                    sibling.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&prefix))
                })
                .cloned()
                .collect())
        }
        fn modified(&mut self, path: &Path) -> io::Result<Option<SystemTime>> {
            let at = self.times.get(path).copied().unwrap_or(0);
            Ok(Some(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(at)))
        }
        fn validate_candidate(&mut self, _config_text: &str, _snippet_text: &str, _config_file: &Path) -> io::Result<()> {
            self.events.push("candidate");
            if self.fail_candidate {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "niri: staged candidate invalid"));
            }
            Ok(())
        }
    }

    fn manifest() -> Manifest {
        Manifest::new(Path::new("/home/someone/.config/niri"))
    }

    #[test]
    fn resolves_the_config_directory_portably() {
        let env = |pairs: &[(&str, &str)]| {
            let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            move |key: &str| map.get(key).cloned()
        };
        assert_eq!(
            niri_config_dir(env(&[("HOME", "/home/u"), ("XDG_CONFIG_HOME", "/home/u/.config")])),
            Some(PathBuf::from("/home/u/.config/niri"))
        );
        // XDG wins over HOME, and an explicit NIRI_CONFIG pins the directory.
        assert_eq!(
            niri_config_dir(env(&[("HOME", "/home/u"), ("XDG_CONFIG_HOME", "/xdg")])),
            Some(PathBuf::from("/xdg/niri"))
        );
        assert_eq!(
            niri_config_dir(env(&[("HOME", "/home/u"), ("NIRI_CONFIG", "/etc/niri/custom.kdl")])),
            Some(PathBuf::from("/etc/niri"))
        );
        assert_eq!(niri_config_dir(env(&[])), None);
        assert_eq!(niri_config_dir(env(&[("HOME", "")])), None);
    }

    #[test]
    fn first_run_is_idempotent_and_backs_up_before_writing() {
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        let report = first_run(&mut io, &manifest(), EXE, "20260101T000000Z", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap();
        assert_eq!(
            report,
            Report { wrote_snippet: true, wrote_include: true, backup: Some("config") }
        );
        let config = io.files[&manifest().config_file].clone();
        assert!(config.starts_with(CONFIG), "the user's own binds survive");
        assert!(kdl_binds::includes_snippet(&config));
        let snippet = io.files[&manifest().snippet].clone();
        assert_eq!(kdl_binds::bound_key(&snippet, kdl_binds::TOGGLE_ARG).as_deref(), Some(kdl_binds::DEFAULT_KEY));
        // The backup holds the untouched original and validation ran once.
        assert_eq!(io.files[&backup_path(&manifest().config_file, "20260101T000000Z")], CONFIG);
        assert_eq!(io.validated, vec![manifest().config_file]);
        // A second run writes nothing at all.
        io.written.clear();
        io.validated.clear();
        assert_eq!(
            first_run(&mut io, &manifest(), EXE, "20260101T000001Z", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap(),
            Report { wrote_snippet: false, wrote_include: false, backup: None }
        );
        assert!(io.written.is_empty());
        assert!(io.validated.is_empty());
    }

    #[test]
    fn keeps_the_newest_backups_and_removes_the_older_ones() {
        let mut io = Fake::new(&[("/home/someone/.config/niri/gentle-dot.kdl", SNIPPET)]);
        let live = manifest().snippet;
        for age in 0..5u64 {
            let path = backup_path(&live, &format!("stamp-{age}"));
            io.files.insert(path.clone(), SNIPPET.to_owned());
            io.times.insert(path, 100 + age);
        }
        prune_backups(&mut io, &live);
        assert_eq!(io.backups_of(&live), vec!["stamp-2", "stamp-3", "stamp-4"]);
    }

    #[test]
    fn leaves_a_short_history_alone() {
        let mut io = Fake::new(&[("/home/someone/.config/niri/gentle-dot.kdl", SNIPPET)]);
        let live = manifest().snippet;
        for age in 0..2u64 {
            let path = backup_path(&live, &format!("stamp-{age}"));
            io.files.insert(path.clone(), SNIPPET.to_owned());
            io.times.insert(path, 100 + age);
        }
        prune_backups(&mut io, &live);
        assert_eq!(io.backups_of(&live), vec!["stamp-0", "stamp-1"]);
    }

    #[test]
    fn a_successful_write_does_not_leave_one_backup_per_write() {
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", CONFIG),
            ("/home/someone/.config/niri/gentle-dot.kdl", SNIPPET),
        ]);
        let live = manifest().snippet;
        for age in 0..4u64 {
            let path = backup_path(&live, &format!("stamp-{age}"));
            io.files.insert(path.clone(), SNIPPET.to_owned());
            io.times.insert(path, 100 + age);
        }
        first_run(&mut io, &manifest(), EXE, "20260101T000000Z", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap();
        let left = io.backups_of(&live);
        assert_eq!(left.len(), BACKUPS_KEPT, "the folder keeps a bounded history");
        assert!(left.contains(&"20260101T000000Z".to_owned()), "the write's own backup is the newest");
    }

    #[test]
    fn a_refused_write_keeps_every_backup() {
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", CONFIG),
            ("/home/someone/.config/niri/gentle-dot.kdl", SNIPPET),
        ]);
        io.fail_validate = true;
        let live = manifest().snippet;
        for age in 0..4u64 {
            let path = backup_path(&live, &format!("stamp-{age}"));
            io.files.insert(path.clone(), SNIPPET.to_owned());
            io.times.insert(path, 100 + age);
        }
        let error =
            first_run(&mut io, &manifest(), EXE, "stamp-new", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap_err();
        assert_eq!(error.to_string(), "niri: config invalid");
        assert_eq!(io.backups_of(&live).len(), 5, "a refused write keeps what it may still need");
    }

    #[test]
    fn a_refused_validation_restores_the_backup() {
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        io.fail_validate = true;
        let error = first_run(&mut io, &manifest(), EXE, "stamp", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap_err();
        assert_eq!(error.to_string(), "niri: config invalid");
        assert_eq!(io.files[&manifest().config_file], CONFIG, "the original config is back");
        assert!(!io.files.contains_key(&manifest().snippet), "a created snippet is removed again");
        assert_eq!(io.validated, vec![manifest().config_file]);
    }

    #[test]
    fn an_included_snippet_without_our_binding_gains_one() {
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", included.as_str()),
            ("/home/someone/.config/niri/gentle-dot.kdl", "window-rule {\n    open-floating true\n}\n"),
        ]);
        let report = first_run(&mut io, &manifest(), EXE, "stamp", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap();
        assert_eq!(report, Report { wrote_snippet: true, wrote_include: false, backup: Some("snippet") });
        assert_eq!(io.files[&manifest().config_file], included, "config.kdl is not rewritten");
        assert_eq!(
            kdl_binds::bound_key(&io.files[&manifest().snippet], kdl_binds::TOGGLE_ARG).as_deref(),
            Some(kdl_binds::DEFAULT_KEY)
        );
        assert_eq!(io.validated, vec![manifest().config_file]);
    }

    #[test]
    fn the_include_line_lands_after_the_existing_text() {
        assert_eq!(with_include(CONFIG), Some(format!("{CONFIG}{}\n", kdl_binds::include_line())));
        // A file without a trailing newline still gets a clean include line.
        assert_eq!(with_include("binds {\n}"), Some(format!("binds {{\n}}\n{}\n", kdl_binds::include_line())));
        assert_eq!(with_include(""), Some(format!("{}\n", kdl_binds::include_line())));
        // Already included: no rewrite.
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        assert_eq!(with_include(&included), None);
    }

    #[test]
    fn the_real_io_round_trips_and_replaces_atomically() {
        // Real filesystem, but only inside a throwaway directory: the user's home
        // is never touched by a test.
        let root = std::env::temp_dir().join(format!("gd-config-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let config = root.join("config.kdl");
        let copy = root.join("config.kdl.copy");
        let mut io = RealConfigIo;
        io.write(&config, CONFIG).expect("write");
        assert_eq!(io.read(&config).expect("read"), CONFIG);
        io.copy(&config, &copy).expect("copy");
        assert_eq!(io.read(&copy).expect("read copy"), CONFIG);
        // The temporary file never survives a successful write.
        assert!(!root.join("config.kdl.gd-tmp").exists());
        // A missing file is a NotFound, never empty text.
        assert_eq!(io.read(&root.join("absent.kdl")).unwrap_err().kind(), io::ErrorKind::NotFound);
        // Removing a live file deletes it; removing absence stays Ok.
        io.remove(&copy).expect("remove");
        assert!(!copy.exists());
        io.remove(&copy).expect("second remove is still absence");
        std::fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn each_verb_gets_its_own_line_and_neither_erases_the_other() {
        // The repair is per verb: wiring a second verb keeps the first one's
        // line. (The fullscreen verb below is only a test stand-in — the app
        // manages the open/close toggle and nothing else.)
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        first_run(&mut io, &manifest(), EXE, "s1", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap();
        first_run(&mut io, &manifest(), EXE, "s2", "--zoom", "Mod+Z").unwrap();
        let snippet = io.files[&manifest().snippet].clone();
        assert_eq!(kdl_binds::bound_key(&snippet, kdl_binds::TOGGLE_ARG).as_deref(), Some(kdl_binds::DEFAULT_KEY));
        assert_eq!(kdl_binds::bound_key(&snippet, "--zoom").as_deref(), Some("Mod+Z"));
        assert_eq!(io.validated, vec![manifest().config_file.clone(), manifest().config_file]);
    }

    #[test]
    fn the_plan_matrix_covers_every_first_run_case() {
        assert_eq!(plan_first_run(CONFIG, false, "", kdl_binds::TOGGLE_ARG), Plan::CreateAndInclude);
        assert_eq!(plan_first_run(CONFIG, true, SNIPPET, kdl_binds::TOGGLE_ARG), Plan::CreateAndInclude);
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        assert_eq!(plan_first_run(&included, false, "", kdl_binds::TOGGLE_ARG), Plan::AddBinding);
        assert_eq!(plan_first_run(&included, true, "window-rule {\n}\n", kdl_binds::TOGGLE_ARG), Plan::AddBinding);
        assert_eq!(plan_first_run(&included, true, SNIPPET, kdl_binds::TOGGLE_ARG), Plan::Ready);
        // The plan is per verb: a snippet that binds the toggle still plans an
        // add for any other verb.
        assert_eq!(plan_first_run(&included, true, SNIPPET, "--zoom"), Plan::AddBinding);
    }

    #[test]
    fn an_impossible_accelerator_fails_before_any_io() {
        // Pure mapping runs first: no home directory is read, no file written.
        assert!(write_toggle_binding("Alt+").is_err());
        assert!(write_toggle_binding("").is_err());
        assert!(write_toggle_binding("Alt+SuperKey").is_err());
    }

    #[test]
    fn snippet_read_errors_propagate_instead_of_reading_empty() {
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        io.fail_snippet_read = true;
        let before = io.files.clone();
        let error =
            first_run(&mut io, &manifest(), EXE, "stamp", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(io.written.is_empty(), "a rejected read must not publish anything");
        assert_eq!(io.files, before);
    }

    #[test]
    fn a_staged_candidate_is_gated_before_any_live_write() {
        // Order: the staged gate runs before the first live write.
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        first_run(&mut io, &manifest(), EXE, "stamp", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap();
        assert_eq!(io.events, vec!["candidate", "write", "write", "validate"]);
        // A refused candidate publishes nothing: no writes, no backups.
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        io.fail_candidate = true;
        let before = io.files.clone();
        let error =
            first_run(&mut io, &manifest(), EXE, "stamp", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap_err();
        assert_eq!(error.to_string(), "niri: staged candidate invalid");
        assert_eq!(io.events, vec!["candidate"]);
        assert!(io.written.is_empty());
        assert_eq!(io.files, before);
    }

    #[test]
    fn toggle_write_ensures_the_include_instead_of_a_false_success() {
        // No include and no snippet: one call wires both, a second is a no-op.
        let mut io = Fake::new(&[("/home/someone/.config/niri/config.kdl", CONFIG)]);
        assert_eq!(apply_toggle(&mut io, &manifest(), EXE, "s1", "Alt+Space").unwrap(), "Alt+Space");
        assert!(kdl_binds::includes_snippet(&io.files[&manifest().config_file]));
        assert_eq!(
            kdl_binds::bound_key(&io.files[&manifest().snippet], kdl_binds::TOGGLE_ARG).as_deref(),
            Some("Alt+Space")
        );
        io.written.clear();
        io.events.clear();
        assert_eq!(apply_toggle(&mut io, &manifest(), EXE, "s2", "Alt+Space").unwrap(), "Alt+Space");
        assert!(io.written.is_empty());
        assert!(io.events.is_empty());
        // Reset to default lands on Alt+Space even from a foreign key, and an
        // unreferenced snippet still gains its include instead of succeeding idle.
        let mut io = Fake::new(&[(
            "/home/someone/.config/niri/config.kdl",
            CONFIG,
        ), (
            "/home/someone/.config/niri/gentle-dot.kdl",
            "binds {\n    Mod+Alt+D { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n}\n",
        )]);
        assert_eq!(apply_toggle(&mut io, &manifest(), EXE, "s3", "Alt+Space").unwrap(), "Alt+Space");
        assert!(kdl_binds::includes_snippet(&io.files[&manifest().config_file]));
        assert_eq!(
            kdl_binds::bound_key(&io.files[&manifest().snippet], kdl_binds::TOGGLE_ARG).as_deref(),
            Some("Alt+Space")
        );
    }

    #[test]
    fn custom_config_filenames_survive_with_a_sibling_snippet() {
        let env = |pairs: &[(&str, &str)]| {
            let map: HashMap<String, String> =
                pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            move |key: &str| map.get(key).cloned()
        };
        assert_eq!(
            niri_config_file(env(&[("HOME", "/home/u"), ("NIRI_CONFIG", "/etc/niri/custom.kdl")])),
            Some(PathBuf::from("/etc/niri/custom.kdl"))
        );
        let manifest = Manifest::from_config_file(Path::new("/etc/niri/custom.kdl"));
        assert_eq!(manifest.config_file, PathBuf::from("/etc/niri/custom.kdl"));
        assert_eq!(manifest.snippet, PathBuf::from("/etc/niri/gentle-dot.kdl"));
        // Default layout is unchanged.
        assert_eq!(
            niri_config_file(env(&[("HOME", "/home/u")])),
            Some(PathBuf::from("/home/u/.config/niri/config.kdl"))
        );
    }

    const MULTILINE_SNIPPET: &str = "binds {\n    Alt+Space {\n        spawn \"/usr/bin/gentle-dot\" \"--toggle\";\n    }\n}\n";
    const BOUND_SNIPPET: &str =
        "binds {\n    Alt+Space hotkey-overlay-title=\"Gentle Dot\" { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n}\n";

    #[test]
    fn effective_include_gates_the_read_toggle() {
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        assert_eq!(
            effective_toggle_binding(&included, BOUND_SNIPPET).as_deref(),
            Some("Alt+Space")
        );
        // Same snippet bytes, no include line: unknown, not a phantom key.
        assert_eq!(effective_toggle_binding(CONFIG, BOUND_SNIPPET), None);
        // Included but unbound: unknown as well.
        assert_eq!(effective_toggle_binding(&included, "binds {\n}\n"), None);
    }

    #[test]
    fn staged_root_rewrites_owned_and_sibling_includes() {
        let parent = Path::new("/home/u/.config/niri");
        let staged = Path::new("/tmp/stage-9/gentle-dot.kdl");
        let text = concat!(
            "include \"/home/u/.config/niri/gentle-dot.kdl\"\n",
            "include \"siblings/extra.kdl\"\n",
            "include \"/etc/niri/other.kdl\"\n",
            "// include \"gentle-dot.kdl\"\n",
            "binds {\n}\n",
        );
        let staged_root = rewrite_staged_root(text, staged, parent).unwrap();
        assert!(staged_root.contains("include \"/tmp/stage-9/gentle-dot.kdl\""), "owned absolute must hit the candidate");
        assert!(!staged_root.contains("/home/u/.config/niri/gentle-dot.kdl"), "live bytes must not leak into staging");
        assert!(
            staged_root.contains("include \"/home/u/.config/niri/siblings/extra.kdl\""),
            "sibling joins the original parent"
        );
        assert!(staged_root.contains("include \"/etc/niri/other.kdl\""), "foreign absolute untouched");
        assert!(staged_root.contains("// include \"gentle-dot.kdl\""), "comment untouched");
        assert_eq!(staged_root.lines().count(), text.lines().count());
    }

    #[test]
    fn unsupported_multiline_leaves_files_unchanged() {
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", included.as_str()),
            ("/home/someone/.config/niri/gentle-dot.kdl", MULTILINE_SNIPPET),
        ]);
        let before = io.files.clone();
        let error =
            first_run(&mut io, &manifest(), EXE, "stamp", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap_err();
        assert!(error.to_string().contains("multiline"), "unexpected error: {error}");
        assert_eq!(io.files, before);
        assert!(io.written.is_empty());
        assert!(io.events.is_empty());
    }

    #[test]
    fn toggle_write_rejects_unsupported_layout() {
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", CONFIG),
            ("/home/someone/.config/niri/gentle-dot.kdl", MULTILINE_SNIPPET),
        ]);
        // CONFIG lacks the include: it must still not be published on refusal.
        let before = io.files.clone();
        let error = apply_toggle(&mut io, &manifest(), EXE, "stamp", "Alt+Space").unwrap_err();
        assert!(error.to_string().contains("multiline"), "unexpected error: {error}");
        assert_eq!(io.files, before);
        assert!(io.written.is_empty());
    }

    #[test]
    fn backup_stamps_are_unique() {
        assert_ne!(stamp(), stamp());
    }

    #[test]
    fn backup_paths_sit_next_to_their_file() {
        assert_eq!(
            backup_path(Path::new("/home/u/.config/niri/config.kdl"), "stamp"),
            PathBuf::from("/home/u/.config/niri/config.kdl.gd-backup-stamp")
        );
        assert_eq!(
            backup_path(Path::new("/home/u/.config/niri/gentle-dot.kdl"), "s"),
            PathBuf::from("/home/u/.config/niri/gentle-dot.kdl.gd-backup-s")
        );
    }

    const DECORATION_SNIPPET: &str = concat!(
        "window-rule {\n",
        "    match title=\"^Gentle Dot Panel$\"\n",
        "    open-floating true\n",
        "}\n",
        "binds {\n",
        "    Alt+Space hotkey-overlay-title=\"Gentle Dot\" { spawn \"/usr/bin/gentle-dot\" \"--toggle\"; }\n",
        "}\n",
    );

    #[test]
    fn ready_snippet_gains_decorations_through_the_repair_transaction() {
        // Binding already correct (Ready): the same transaction still
        // publishes the three off rules, with backup + staged gate + live
        // validation, and a second run writes nothing.
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", included.as_str()),
            ("/home/someone/.config/niri/gentle-dot.kdl", DECORATION_SNIPPET),
        ]);
        let report =
            first_run(&mut io, &manifest(), EXE, "deco", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap();
        assert_eq!(report, Report { wrote_snippet: true, wrote_include: false, backup: Some("snippet") });
        let snippet = io.files[&manifest().snippet].clone();
        assert!(snippet.contains("border { off; }"));
        assert!(snippet.contains("focus-ring { off; }"));
        assert!(snippet.contains("shadow { off; }"));
        assert_eq!(
            kdl_binds::bound_key(&snippet, kdl_binds::TOGGLE_ARG).as_deref(),
            Some(kdl_binds::DEFAULT_KEY)
        );
        assert_eq!(io.events, vec!["candidate", "write", "validate"]);
        // Second run: already present means no write at all.
        io.written.clear();
        io.events.clear();
        io.validated.clear();
        assert_eq!(
            first_run(&mut io, &manifest(), EXE, "deco2", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap(),
            Report { wrote_snippet: false, wrote_include: false, backup: None }
        );
        assert!(io.written.is_empty());
        assert!(io.events.is_empty());
    }

    #[test]
    fn refused_decoration_candidate_restores_the_previous_bytes() {
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", included.as_str()),
            ("/home/someone/.config/niri/gentle-dot.kdl", DECORATION_SNIPPET),
        ]);
        io.fail_validate = true;
        let error =
            first_run(&mut io, &manifest(), EXE, "deco", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap_err();
        assert_eq!(error.to_string(), "niri: config invalid");
        assert_eq!(io.files[&manifest().snippet], DECORATION_SNIPPET, "previous bytes are back");
        assert_eq!(io.files[&manifest().config_file], included);
    }

    #[test]
    fn a_failing_restore_is_reported_rather_than_discarded() {
        // Advisory 2: when live validation refuses AND the backup restore
        // fails, the error carries both failures instead of swallowing the
        // restore. The Ready path restores via copy (snippet was backed up).
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", included.as_str()),
            ("/home/someone/.config/niri/gentle-dot.kdl", DECORATION_SNIPPET),
        ]);
        io.fail_validate = true;
        io.fail_restore_copy = true;
        let error =
            first_run(&mut io, &manifest(), EXE, "deco", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap_err();
        assert!(error.to_string().contains("niri: config invalid"), "original failure kept: {error}");
        assert!(error.to_string().contains("restore"), "restore failure visible: {error}");
    }

    #[test]
    fn ready_heal_adds_open_focused_false_and_stays_idempotent() {
        // Rose-only must never take focus on map: the Ready repair heals the
        // compositor rule alongside the decorations, and a second run writes
        // nothing.
        let included = format!("{CONFIG}{}\n", kdl_binds::include_line());
        let mut io = Fake::new(&[
            ("/home/someone/.config/niri/config.kdl", included.as_str()),
            ("/home/someone/.config/niri/gentle-dot.kdl", DECORATION_SNIPPET),
        ]);
        let report =
            first_run(&mut io, &manifest(), EXE, "focus", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY)
                .unwrap();
        assert_eq!(report, Report { wrote_snippet: true, wrote_include: false, backup: Some("snippet") });
        let snippet = io.files[&manifest().snippet].clone();
        assert!(snippet.contains("open-focused false"), "healed: {snippet}");
        assert_eq!(snippet.matches("open-focused").count(), 1);
        io.written.clear();
        io.events.clear();
        assert_eq!(
            first_run(&mut io, &manifest(), EXE, "focus2", kdl_binds::TOGGLE_ARG, kdl_binds::DEFAULT_KEY).unwrap(),
            Report { wrote_snippet: false, wrote_include: false, backup: None }
        );
        assert!(io.written.is_empty());
        assert!(io.events.is_empty());
    }
}
