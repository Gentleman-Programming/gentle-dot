//! Fork-only macOS updater. The public key is baked into the binary; no runtime
//! environment variable, webview command or model message can replace its trust root.
use crate::alert::{self, Choice};
use semver::Version;
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

const REPOSITORY: &str = match option_env!("GENTLE_DOT_UPDATE_REPOSITORY") {
    Some(repo) => repo,
    None => "Gentleman-Programming/gentle-dot",
};
const PUBLIC_KEY: &str = match option_env!("GENTLE_DOT_UPDATE_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};
static BUSY: AtomicBool = AtomicBool::new(false);
type Cleanup = Arc<dyn Fn(&AppHandle) + Send + Sync>;
struct UpdateState(Cleanup);
struct Flight;
impl Drop for Flight {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

use crate::update_policy::{latest, Release};

fn message(app: &AppHandle, text: &str) {
    app.dialog()
        .message(text)
        .title("Actualizaciones de Gentle Dot QA")
        .blocking_show();
}

pub fn start(app: AppHandle, cleanup: Cleanup) {
    app.manage(UpdateState(cleanup));
    check_now(app.clone(), false);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(24 * 60 * 60));
        check_now(app.clone(), false);
    });
}

pub fn check_now(app: AppHandle, manual: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let _flight = Flight;
        if PUBLIC_KEY.trim().is_empty() {
            if manual {
                message(&app, "Esta compilación no tiene clave pública de actualización. Instala una compilación firmada del fork; no se descargarán actualizaciones sin validar.");
            }
            return;
        }
        let result = check(&app);
        match result {
            Ok(false) if manual => message(&app, "No hay una versión QA posterior disponible."),
            Err(error) => {
                eprintln!("gentle-dot updater: {error}");
                if manual {
                    message(&app, "No se pudo comprobar o instalar la actualización. Revisa la red y los registros. No se omitió la validación de firma.");
                }
            }
            _ => (),
        }
    });
}

fn check(app: &AppHandle) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let parts: Vec<_> = REPOSITORY.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Invalid compiled update repository".into());
    }
    let api = format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=100");
    let base = format!("https://github.com/{REPOSITORY}/releases/download/");
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build()
        .get(&api)
        .set("User-Agent", "gentle-dot-maicololiveras-updater")
        .set("Accept", "application/vnd.github+json")
        .call()?;
    let mut data = Vec::new();
    response
        .into_reader()
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut data)?;
    if data.len() > 2 * 1024 * 1024 {
        return Err("Release listing exceeds limit".into());
    }
    let releases: Vec<Release> = serde_json::from_slice(&data)?;
    let current = Version::parse(&app.package_info().version.to_string())?;
    let Some((tag, expected)) = latest(&releases, &current) else {
        return Ok(false);
    };
    let feed = format!("{base}{tag}/latest.json");
    let updater = app
        .updater_builder()
        .pubkey(PUBLIC_KEY.trim())
        .endpoints(vec![feed.parse()?])?
        .timeout(Duration::from_secs(600))
        .build()?;
    let Some(update) = tauri::async_runtime::block_on(updater.check())? else {
        return Ok(false);
    };
    if Version::parse(&update.version)? != expected || expected <= current {
        return Err("Release tag and update version disagree".into());
    }
    let prefix = format!("{base}{tag}/");
    if !update.download_url.as_str().starts_with(&prefix)
        || !update.download_url.path().ends_with(".app.tar.gz")
        || update.download_url.query().is_some()
        || update.download_url.fragment().is_some()
    {
        return Err("Update artifact must belong to the selected fork release".into());
    }
    let notes: String = update
        .body
        .as_deref()
        .unwrap_or("")
        .chars()
        .take(2000)
        .collect();
    if !alert::ask(
        app,
        "Nueva versión de Gentle Dot QA",
        &format!(
            "Versión {current} → {expected}\n\n{notes}\n\n¿Descargar y verificar la actualización?"
        ),
        Choice {
            allow: "Descargar",
            refuse: "Más tarde",
        },
    ) {
        return Ok(true);
    }
    // Tauri verifies the updater signature before returning these bytes.
    let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}))?;
    if !alert::ask(app, "Actualización verificada",
        "Instalar y reiniciar cerrará las tareas activas, el micrófono y el control del equipo. Guarda tu trabajo antes de continuar. Tus conversaciones y memoria se conservarán.",
        Choice { allow: "Instalar y reiniciar", refuse: "Más tarde" }) { return Ok(true); }
    update.install(bytes)?;
    (app.state::<UpdateState>().0)(app);
    app.restart();
}
