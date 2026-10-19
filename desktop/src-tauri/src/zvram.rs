use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{path::BaseDirectory, AppHandle, Manager, WebviewWindow};

use super::{config_path, ensure_not_quitting, load_config_at, require_main, NativeState};

const BRIDGE: &str = include_str!("zvram_bridge.py");
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const CACHED_ROUTER_TIMEOUT: Duration = Duration::from_secs(45);
const MODEL_SYNC_SERVICE: &str = "novum-local-model-sync.service";

fn read_recovery_intent(intent: &std::sync::Mutex<Option<bool>>) -> Option<bool> {
    intent.lock().map(|value| *value).unwrap_or(Some(false))
}

fn router_recovery_enabled(auto_start: bool, intent: Option<bool>) -> bool {
    intent.unwrap_or(auto_start)
}

fn decorate_recovery_status(mut status: Value, intent: Option<bool>) -> Value {
    if let Some(router) = status.get_mut("router").filter(|router| router.is_object()) {
        let auto_start = router["auto_start"] != false;
        router["recovery_enabled"] = json!(router_recovery_enabled(auto_start, intent));
    }
    status
}

fn router_should_adopt_running(auto_start: bool, running: bool, intent: Option<bool>) -> bool {
    running && !auto_start && intent.is_none()
}

fn router_installation_changed(previous: Option<&Path>, selected: &Path) -> bool {
    previous != Some(selected)
}

fn router_observed_intentional_exit(
    running: bool,
    state: &str,
    was_running: bool,
    intent: Option<bool>,
    lastlog: &str,
) -> bool {
    !running
        && !matches!(state, "starting" | "running")
        && (was_running || intent == Some(true))
        && matches!(lastlog, "Stopped by user" | "Process exited (0)")
}

fn router_intent_after_observed_exit(
    intent: Option<bool>,
    running: bool,
    state: &str,
    was_running: bool,
    lastlog: &str,
) -> Option<bool> {
    if router_observed_intentional_exit(running, state, was_running, intent, lastlog) {
        Some(false)
    } else {
        intent
    }
}

fn router_intent_after_action(
    intent: Option<bool>,
    action: &ZvramAction,
    bridge_succeeded: bool,
) -> Option<bool> {
    match action {
        ZvramAction::RouterStop => Some(false),
        ZvramAction::RouterStart if bridge_succeeded => Some(true),
        _ => intent,
    }
}

fn router_start_eligible(
    recovery_enabled: bool,
    running: bool,
    state: &str,
    retry_ticks: u8,
) -> bool {
    recovery_enabled
        && !running
        && !matches!(state, "starting" | "running")
        && retry_ticks == 0
}

fn router_failure_waits_before_retry(state: &str, lastlog: &str) -> bool {
    matches!(state, "failed" | "exited")
        || (state == "stopped"
            && (lastlog.starts_with("Stopped:")
                || (lastlog.starts_with("Process exited (") && lastlog != "Process exited (0)")))
}

fn next_router_retry_delay(delay: u8) -> u8 {
    delay.saturating_mul(2).min(6)
}

fn monitor_start_request(mode: String, auto_start: bool) -> ZvramRequest {
    ZvramRequest {
        action: ZvramAction::RouterStart,
        mode: Some(mode),
        auto_start: Some(auto_start),
        ..ZvramRequest::status()
    }
}

#[cfg(target_os = "linux")]
fn model_sync_unit_contents(
    checkout: &Path,
    script: &Path,
    installation: &Path,
    cookie_path: &Path,
    backend_port: u16,
    cache_root: &Path,
    installation_config: &Path,
) -> Result<String, String> {
    let checkout = checkout
        .to_str()
        .ok_or("Configured checkout path is not valid UTF-8.")?;
    let script = super::alarms::systemd_quote(
        script.to_str().ok_or("Model-sync script path is not valid UTF-8.")?,
    )?;
    let installation = super::alarms::systemd_quote(
        installation
            .to_str()
            .ok_or("zVram installation path is not valid UTF-8.")?,
    )?;
    let backend = super::alarms::systemd_quote(
        checkout,
    )?;
    let cookie = super::alarms::systemd_quote(
        cookie_path
            .to_str()
            .ok_or("Session-cookie path is not valid UTF-8.")?,
    )?;
    let cache = super::alarms::systemd_quote(
        cache_root
            .to_str()
            .ok_or("Model-cache path is not valid UTF-8.")?,
    )?;
    let installation_config = super::alarms::systemd_quote(
        installation_config
            .to_str()
            .ok_or("Installation-config path is not valid UTF-8.")?,
    )?;
    Ok(format!(
        "[Unit]\nDescription=Novum Xenium local model cache sync\n# Novum-Checkout: {checkout}\n\n[Service]\nType=simple\nUMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=10s\nExecStart=/usr/bin/python3 -I {script} watch {installation} {backend} {cookie} {backend_port} {cache} 30 {installation_config}\n\n[Install]\nWantedBy=default.target\n"
    ))
}

#[cfg(target_os = "linux")]
fn provision_model_sync_service(
    app: &AppHandle,
    config: &super::DesktopConfig,
    installation: &Path,
) -> Result<(), String> {
    let checkout = fs::canonicalize(&config.checkout)
        .map_err(|_| "The configured backend checkout is unavailable.".to_string())?;
    let cache_root = super::alarms::hf_cache_source(config)?;
    let app_data = app
        .path()
        .resolve("novum-xenium/zvram/model-sync/v1", BaseDirectory::Data)
        .map_err(|e| format!("Cannot resolve local model-sync application data: {e}"))?;
    let systemd_user = app
        .path()
        .resolve("systemd/user", BaseDirectory::Config)
        .map_err(|e| format!("Cannot resolve user systemd configuration: {e}"))?;
    let cookie_path = app
        .path()
        .resolve("cookies", BaseDirectory::AppData)
        .map_err(|e| format!("Cannot resolve desktop session cookie storage: {e}"))?;
    let script_path = app_data.join("zvram_bridge.py");
    let installation_config = zvram_config_path(app)?;
    let unit = model_sync_unit_contents(
        &checkout,
        &script_path,
        installation,
        &cookie_path,
        config.port,
        &cache_root,
        &installation_config,
    )?;
    super::alarms::provision_owned_service(
        &checkout,
        &script_path,
        BRIDGE,
        &systemd_user,
        MODEL_SYNC_SERVICE,
        &unit,
    )
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum ZvramAction {
    Save,
    Start,
    Stop,
    Register,
    Status,
    RouterStart,
    RouterStop,
    RouterRegister,
    RouterConfigure,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(super) struct ZvramRequest {
    action: ZvramAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compressed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resident_mib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cold_mib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clean_cache_mib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    headroom_mib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    virtual_gib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_available_mib: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ignore_swap_guard: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    live_control: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto_start: Option<bool>,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ZvramInstallation {
    checkout: String,
}

fn zvram_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("zvram.json", BaseDirectory::AppConfig)
        .map_err(|e| format!("Cannot resolve zVram configuration directory: {e}"))
}

fn read_installation(path: &Path) -> Result<Option<PathBuf>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the saved zVram installation.".into()),
    };
    let saved: ZvramInstallation = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved zVram installation is invalid; choose it again.".to_string())?;
    validate_installation(Path::new(&saved.checkout)).map(Some)
}

fn validate_installation(path: &Path) -> Result<PathBuf, String> {
    let checkout = fs::canonicalize(path)
        .map_err(|_| "Choose an existing zVram installation directory.".to_string())?;
    if !checkout.is_dir()
        || !checkout.join("zvram_manager.py").is_file()
        || !checkout.join("zvram_model.py").is_file()
        || !checkout.join("zvram").is_file()
    {
        return Err(
            "The selected directory must contain zvram_manager.py, zvram_model.py, and zvram."
                .into(),
        );
    }
    Ok(checkout)
}

fn installation_for_candidate(candidate: &Path) -> Option<PathBuf> {
    let resolved = fs::canonicalize(candidate).ok()?;
    let root = if resolved.is_dir() {
        resolved
    } else {
        resolved.parent()?.to_path_buf()
    };
    validate_installation(&root).ok()
}

fn find_installation(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find_map(|candidate| installation_for_candidate(&candidate))
}

fn detect_installation(backend_checkout: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join("zvram"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/zvram"));
    }
    candidates.extend([
        PathBuf::from("/usr/local/bin/zvram"),
        PathBuf::from("/usr/bin/zvram"),
    ]);
    if let Some(backend_checkout) = backend_checkout {
        if let Some(parent) = backend_checkout.parent() {
            candidates.extend([parent.join("zvram"), parent.join("zVram")]);
        }
    }
    find_installation(candidates)
}

fn read_or_detect_installation(
    config_path: &Path,
    discover: impl FnOnce() -> Option<PathBuf>,
) -> Result<Option<PathBuf>, String> {
    match read_installation(config_path) {
        Ok(Some(saved)) => return Ok(Some(saved)),
        Ok(None) => {}
        Err(error) => {
            if let Some(detected) = discover() {
                save_installation(config_path, &detected)?;
                return Ok(Some(detected));
            }
            return Err(error);
        }
    }
    if let Some(detected) = discover() {
        save_installation(config_path, &detected)?;
        return Ok(Some(detected));
    }
    Ok(None)
}

fn save_installation(path: &Path, checkout: &Path) -> Result<String, String> {
    let parent = path
        .parent()
        .ok_or("zVram configuration path has no parent directory.")?;
    fs::create_dir_all(parent)
        .map_err(|_| "Cannot create the zVram configuration directory.".to_string())?;
    let installation = ZvramInstallation {
        checkout: checkout.to_string_lossy().into_owned(),
    };
    let bytes = serde_json::to_vec_pretty(&installation)
        .map_err(|_| "Cannot serialize zVram installation.".to_string())?;
    let temp = parent.join(format!("zvram.json.tmp-{}", std::process::id()));
    fs::write(&temp, bytes).map_err(|_| "Cannot save zVram installation.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot protect zVram installation configuration.".to_string())?;
    }
    fs::rename(&temp, path).map_err(|_| "Cannot save zVram installation.".to_string())?;
    Ok(installation.checkout)
}

fn unavailable_status(message: &str) -> Value {
    json!({
        "available": false,
        "message": message,
        "models": [],
        "profiles": [],
        "router_supported": false,
        "router": null,
    })
}

fn platform_supported() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("zVram host controls are currently supported on Linux only.".into())
    }
}

fn run_bridge(
    app: &AppHandle,
    installation: &Path,
    request: &ZvramRequest,
) -> Result<Value, String> {
    platform_supported()?;
    let backend_path = config_path(app)?;
    let backend =
        load_config_at(&backend_path)?.ok_or("Configure a backend checkout before using zVram.")?;
    let cookie_path = app
        .path()
        .resolve("cookies", BaseDirectory::AppData)
        .map_err(|e| format!("Cannot resolve desktop session cookie storage: {e}"))?;
    let request_json = serde_json::to_string(request)
        .map_err(|_| "Cannot serialize the zVram request.".to_string())?;
    let mut args = vec![
        "-I".to_string(),
        "-c".to_string(),
        BRIDGE.to_string(),
        installation.to_string_lossy().into_owned(),
        backend.checkout.clone(),
        cookie_path.to_string_lossy().into_owned(),
        backend.port.to_string(),
        request_json,
    ];
    #[cfg(target_os = "linux")]
    let cache_root = if request_needs_cached_models(request) {
        super::alarms::hf_cache_source(&backend).ok()
    } else {
        None
    };
    // Host model routing is Linux-only; the alarms/mount bridge is not built
    // on Windows/macOS. Keep the desktop app compilable on those platforms.
    #[cfg(not(target_os = "linux"))]
    let cache_root: Option<PathBuf> = None;
    if let Some(cache_root) = cache_root {
        args.push(cache_root.to_string_lossy().into_owned());
    }
    let env = bridge_environment();
    let timeout = if request_needs_cached_models(request) {
        CACHED_ROUTER_TIMEOUT
    } else {
        COMMAND_TIMEOUT
    };
    let output = super::run_command_env("python3", &args, Some(installation), timeout, &env)?;
    if output.truncated {
        return Err("The zVram bridge response exceeded its output limit.".into());
    }
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The zVram bridge returned an invalid response.".to_string())?;
    if output.code != Some(0) {
        let error = result
            .get("error")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty() && text.len() <= 1200)
            .unwrap_or("The zVram operation failed.");
        return Err(error.to_string());
    }
    Ok(result)
}

fn request_needs_cached_models(request: &ZvramRequest) -> bool {
    matches!(
        request.action,
        ZvramAction::RouterStart | ZvramAction::RouterConfigure
    )
}

pub(super) fn filtered_library_path(appdir: Option<&Path>, value: &OsStr) -> OsString {
    let Some(appdir) = appdir else {
        return value.to_os_string();
    };
    let appdir = fs::canonicalize(appdir).unwrap_or_else(|_| appdir.to_path_buf());
    let entries = std::env::split_paths(value).filter(|entry| {
        let resolved = fs::canonicalize(entry).unwrap_or_else(|_| entry.clone());
        !resolved.starts_with(&appdir)
    });
    std::env::join_paths(entries).unwrap_or_else(|_| value.to_os_string())
}

fn bridge_environment() -> Vec<(&'static str, String)> {
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    let inherited = std::env::var_os("LD_LIBRARY_PATH").unwrap_or_default();
    vec![
        ("PYTHONHOME", String::new()),
        ("PYTHONPATH", String::new()),
        (
            "LD_LIBRARY_PATH",
            filtered_library_path(appdir.as_deref(), &inherited)
                .to_string_lossy()
                .into_owned(),
        ),
    ]
}

#[tauri::command]
pub(super) async fn zvram_status(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, NativeState>,
) -> Result<Value, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    platform_supported()?;
    let app = app.clone();
    let lock = state.zvram_operation.clone();
    let quit_pending = state.quit_pending.clone();
    let recovery_state = state.zvram_recovery_intent.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "zVram operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let install_path = zvram_config_path(&app)?;
        let backend_path = config_path(&app)?;
        let backend = load_config_at(&backend_path)?;
        let backend_checkout = backend.as_ref().map(|config| Path::new(&config.checkout));
        let Some(installation) =
            read_or_detect_installation(&install_path, || detect_installation(backend_checkout))?
        else {
            let mut result =
                unavailable_status("zVram was not detected. Choose an installation to begin.");
            result["installation"] = Value::String(String::new());
            return Ok(result);
        };
        let request = ZvramRequest::status();
        run_bridge(&app, &installation, &request)
            .map(|status| decorate_recovery_status(status, read_recovery_intent(&recovery_state)))
    })
    .await
    .map_err(|e| format!("zVram status worker failed: {e}"))?
}

#[tauri::command]
pub(super) async fn zvram_choose_installation(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, NativeState>,
) -> Result<Option<String>, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    platform_supported()?;
    let path = zvram_config_path(&app)?;
    let lock = state.zvram_operation.clone();
    let quit_pending = state.quit_pending.clone();
    let recovery_intent = state.zvram_recovery_intent.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "zVram operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let Some(selected) = rfd::FileDialog::new().pick_folder() else {
            return Ok(None);
        };
        let checkout = validate_installation(&selected)?;
        let previous = read_installation(&path).ok().flatten();
        let saved = save_installation(&path, &checkout)?;
        if router_installation_changed(previous.as_deref(), checkout.as_path()) {
            *recovery_intent
                .lock()
                .map_err(|_| "zVram recovery state is unavailable.")? = None;
        }
        Ok(Some(saved))
    })
    .await
    .map_err(|e| format!("zVram folder picker failed: {e}"))?
}

#[tauri::command]
pub(super) async fn zvram_action(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, NativeState>,
    request: ZvramRequest,
) -> Result<Value, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    platform_supported()?;
    let config_path = zvram_config_path(&app)?;
    let installation =
        read_installation(&config_path)?.ok_or("Choose a zVram installation first.")?;
    let app = app.clone();
    let lock = state.zvram_operation.clone();
    let quit_pending = state.quit_pending.clone();
    let recovery_intent = state.zvram_recovery_intent.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "zVram operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        if matches!(&request.action, ZvramAction::RouterStop) {
            let mut intent = recovery_intent
                .lock()
                .map_err(|_| "zVram recovery state is unavailable.")?;
            *intent = router_intent_after_action(*intent, &request.action, false);
        }
        let result = run_bridge(&app, &installation, &request);
        if matches!(&request.action, ZvramAction::RouterStart) && result.is_ok() {
            let mut intent = recovery_intent
                .lock()
                .map_err(|_| "zVram recovery state is unavailable.")?;
            *intent = router_intent_after_action(*intent, &request.action, true);
        }
        result
            .map(|status| decorate_recovery_status(status, read_recovery_intent(&recovery_intent)))
    })
    .await
    .map_err(|e| format!("zVram action worker failed: {e}"))?
}

pub(super) fn monitor_autostart(app: AppHandle) {
    std::thread::spawn(move || {
        let mut start_succeeded = false;
        let mut start_retry_waiting = false;
        let mut start_retry_ticks = 0u8;
        let mut start_retry_delay = 1u8;
        let mut registered = false;
        let mut registration_ticks = 0u8;
        let mut last_mode: Option<String> = None;
        let mut last_installation: Option<PathBuf> = None;
        let mut observed_router_running = false;
        let mut first_attempt = true;
        #[cfg(target_os = "linux")]
        let mut model_sync_key: Option<(String, String, u16)> = None;
        #[cfg(target_os = "linux")]
        let mut model_sync_pending: Option<(String, String, u16)> = None;
        #[cfg(target_os = "linux")]
        let mut model_sync_retry_ticks = 0u8;
        #[cfg(target_os = "linux")]
        let mut model_sync_retry_delay = 1u8;
        loop {
            if !first_attempt {
                std::thread::sleep(Duration::from_secs(10));
            }
            first_attempt = false;
            let Some(state) = app.try_state::<NativeState>() else { break };
            if state.quit_pending.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            let Ok(_guard) = state.zvram_operation.lock() else { continue };
            let Ok(install_path) = zvram_config_path(&app) else { continue };
            let backend_path = match config_path(&app) {
                Ok(path) => path,
                Err(_) => continue,
            };
            let backend = match load_config_at(&backend_path) {
                Ok(Some(config)) => config,
                _ => continue,
            };
            let backend_checkout = Path::new(&backend.checkout);
            let Some(installation) = (match read_or_detect_installation(&install_path, || {
                detect_installation(Some(backend_checkout))
            }) {
                Ok(installation) => installation,
                Err(_) => continue,
            }) else {
                continue;
            };
            if router_installation_changed(last_installation.as_deref(), installation.as_path()) {
                last_installation = Some(installation.clone());
                observed_router_running = false;
                registered = false;
                registration_ticks = 0;
                start_succeeded = false;
                start_retry_waiting = false;
                start_retry_ticks = 0;
                start_retry_delay = 1;
            }
            let status = match run_bridge(&app, &installation, &ZvramRequest::status()) {
                Ok(status) if status["available"] == true => status,
                _ => continue,
            };
            let router = &status["router"];
            let mode = router["mode"].as_str().unwrap_or("regular").to_string();
            if last_mode.as_deref().is_some_and(|previous| previous != mode) {
                registered = false;
                registration_ticks = 0;
                start_succeeded = false;
                start_retry_waiting = false;
                start_retry_ticks = 0;
                start_retry_delay = 1;
            }
            last_mode = Some(mode.clone());
            let router_running = router["running"] == true;
            let auto_start = router["auto_start"] != false;
            let lastlog = router["lastlog"].as_str().unwrap_or("");
            let router_state = router["state"].as_str().unwrap_or("stopped");
            let mut recovery_intent = read_recovery_intent(&state.zvram_recovery_intent);
            let after_exit_intent = router_intent_after_observed_exit(
                recovery_intent,
                router_running,
                router_state,
                observed_router_running,
                lastlog,
            );
            if after_exit_intent != recovery_intent {
                if let Ok(mut intent) = state.zvram_recovery_intent.lock() {
                    *intent = after_exit_intent;
                    recovery_intent = after_exit_intent;
                }
            }
            if router_should_adopt_running(auto_start, router_running, recovery_intent) {
                if let Ok(mut intent) = state.zvram_recovery_intent.lock() {
                    *intent = Some(true);
                    recovery_intent = Some(true);
                }
            }
            let recovery_enabled = router_recovery_enabled(auto_start, recovery_intent);
            if router_running {
                observed_router_running = true;
            } else if !matches!(router_state, "starting" | "running") {
                observed_router_running = false;
            }
            if !router_running {
                registered = false;
                registration_ticks = 0;
            }
            let mut retry_scheduled = false;
            if router_running {
                start_succeeded = true;
                if router["healthy"] == true {
                    start_retry_ticks = 0;
                    start_retry_delay = 1;
                    start_retry_waiting = false;
                }
            } else if !matches!(router_state, "starting" | "running") {
                if recovery_enabled
                    && !start_retry_waiting
                    && (start_succeeded || router_failure_waits_before_retry(router_state, lastlog))
                {
                    start_retry_ticks = start_retry_delay;
                    start_retry_delay = next_router_retry_delay(start_retry_delay);
                    start_retry_waiting = true;
                    retry_scheduled = true;
                }
                start_succeeded = false;
            }
            if router_start_eligible(
                recovery_enabled,
                router_running,
                router_state,
                start_retry_ticks,
            ) {
                start_retry_waiting = false;
                let start = monitor_start_request(mode, auto_start);
                start_succeeded = run_bridge(&app, &installation, &start).is_ok();
                if !start_succeeded {
                    start_retry_ticks = start_retry_delay;
                    start_retry_delay = next_router_retry_delay(start_retry_delay);
                    start_retry_waiting = true;
                }
            } else if start_retry_ticks > 0 && !retry_scheduled {
                start_retry_ticks -= 1;
            }
            if router_running && registered {
                registration_ticks = registration_ticks.saturating_add(1);
                if registration_ticks >= 12 {
                    registered = false;
                    registration_ticks = 0;
                }
            }
            if router_running && !registered && recovery_enabled {
                let register = ZvramRequest {
                    action: ZvramAction::RouterRegister,
                    ..ZvramRequest::status()
                };
                if run_bridge(&app, &installation, &register).is_ok() {
                    registered = true;
                }
            }
            #[cfg(target_os = "linux")]
            let sync_service_request = if router_running && router["healthy"] == true {
                let key = (
                    installation.to_string_lossy().into_owned(),
                    backend.checkout.clone(),
                    backend.port,
                );
                if model_sync_key.as_ref() == Some(&key) {
                    None
                } else {
                    if model_sync_pending.as_ref() != Some(&key) {
                        model_sync_pending = Some(key.clone());
                        model_sync_retry_ticks = 0;
                        model_sync_retry_delay = 1;
                    }
                    if model_sync_retry_ticks > 0 {
                        model_sync_retry_ticks -= 1;
                        None
                    } else {
                        Some((key, backend.clone(), installation.clone()))
                    }
                }
            } else {
                None
            };
            drop(_guard);
            #[cfg(target_os = "linux")]
            if let Some((key, config, installation)) = sync_service_request {
                if provision_model_sync_service(&app, &config, &installation).is_ok() {
                    model_sync_key = Some(key.clone());
                    model_sync_pending = None;
                    model_sync_retry_ticks = 0;
                    model_sync_retry_delay = 1;
                } else {
                    model_sync_retry_ticks = model_sync_retry_delay;
                    model_sync_retry_delay = (model_sync_retry_delay.saturating_mul(2)).min(6);
                }
            }
        }
    });
}

impl ZvramRequest {
    fn status() -> Self {
        Self {
            action: ZvramAction::Status,
            profile: None,
            model: None,
            alias: None,
            port: None,
            context: None,
            compressed: None,
            resident_mib: None,
            cold_mib: None,
            clean_cache_mib: None,
            headroom_mib: None,
            virtual_gib: None,
            min_available_mib: None,
            ignore_swap_guard: None,
            live_control: None,
            mode: None,
            auto_start: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_recovery_separates_startup_preference_from_runtime_intent() {
        assert!(router_recovery_enabled(false, Some(true)));
        assert!(!router_recovery_enabled(true, Some(false)));
        assert!(!router_recovery_enabled(false, None));
        assert!(router_recovery_enabled(true, None));
        // A fresh session still honors the saved launch-on-open preference.
        assert!(router_recovery_enabled(true, None));

        let adopted = if router_should_adopt_running(false, true, None) {
            Some(true)
        } else {
            None
        };
        assert_eq!(adopted, Some(true));
        assert!(router_recovery_enabled(false, adopted));
        assert!(!router_should_adopt_running(false, true, Some(false)));
        let selected = Path::new("/new/zvram");
        let changed = router_installation_changed(Some(Path::new("/old/zvram")), selected);
        assert!(changed);
        let intent = if changed { None } else { Some(true) };
        assert_eq!(intent, None);
        assert!(!router_installation_changed(Some(selected), selected));

        let external_stop =
            router_intent_after_observed_exit(None, false, "stopped", true, "Stopped by user");
        assert_eq!(external_stop, Some(false));
        assert!(!router_recovery_enabled(true, external_stop));
        let clean_exit = router_intent_after_observed_exit(
            Some(true),
            false,
            "stopped",
            false,
            "Process exited (0)",
        );
        assert_eq!(clean_exit, Some(false));
        assert_eq!(
            router_intent_after_observed_exit(None, false, "stopped", false, "Stopped by user"),
            None
        );
        assert_eq!(
            router_intent_after_observed_exit(None, false, "stopped", false, "Process exited (0)"),
            None
        );
        assert!(!router_observed_intentional_exit(
            false,
            "stopped",
            false,
            None,
            "Process exited (0)"
        ));
        // Health failure alone cannot make an owned, running process restart-eligible.
        let enabled = router_recovery_enabled(false, Some(true));
        assert!(enabled);
        assert!(!router_start_eligible(
            enabled, true, "running", 0
        ));
    }

    #[test]
    fn recovery_status_reports_effective_runtime_intent_and_fails_closed_on_poison() {
        let status = json!({
            "available": true,
            "router": { "auto_start": false, "running": true }
        });
        assert_eq!(
            decorate_recovery_status(status.clone(), Some(true))["router"]["recovery_enabled"],
            true
        );
        assert_eq!(
            decorate_recovery_status(status.clone(), Some(false))["router"]["recovery_enabled"],
            false
        );
        assert_eq!(
            decorate_recovery_status(status, None)["router"]["recovery_enabled"],
            false
        );
        assert_eq!(
            decorate_recovery_status(
                json!({ "router": { "auto_start": true, "running": false } }),
                None
            )["router"]["recovery_enabled"],
            true
        );

        let intent = std::sync::Mutex::new(None);
        assert_eq!(read_recovery_intent(&intent), None);
        // A poisoned intent must not fall back to persisted auto_start=true.
        let poisoned = std::sync::Arc::new(std::sync::Mutex::new(None));
        let poisoned_thread = poisoned.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned_thread.lock().unwrap();
            panic!("poison recovery intent for test");
        })
        .join();
        assert_eq!(read_recovery_intent(&poisoned), Some(false));
    }

    #[test]
    fn router_action_intent_preserves_explicit_stop_and_start_ordering() {
        let mut intent = None;
        intent = router_intent_after_action(intent, &ZvramAction::RouterStop, false);
        assert_eq!(intent, Some(false));
        assert!(!router_recovery_enabled(true, intent));

        // A failed start does not erase the explicit stop; a successful one does.
        intent = router_intent_after_action(intent, &ZvramAction::RouterStart, false);
        assert_eq!(intent, Some(false));
        intent = router_intent_after_action(intent, &ZvramAction::RouterStart, true);
        assert_eq!(intent, Some(true));
        assert!(router_recovery_enabled(false, intent));

        // Configure does not change runtime intent; a fresh app defers to auto_start.
        intent = router_intent_after_action(intent, &ZvramAction::RouterConfigure, true);
        assert_eq!(intent, Some(true));
        assert!(!router_recovery_enabled(false, None));
        assert_eq!(
            monitor_start_request("regular".into(), false).auto_start,
            Some(false)
        );
    }

    #[test]
    fn router_retry_backoff_grows_for_short_lived_failures() {
        let mut delay = 1;
        let mut scheduled = Vec::new();
        for _ in 0..5 {
            scheduled.push(delay);
            delay = next_router_retry_delay(delay);
        }
        assert_eq!(scheduled, [1, 2, 4, 6, 6]);
        assert!(router_failure_waits_before_retry(
            "exited",
            "Process exited (1)"
        ));
        assert!(router_failure_waits_before_retry(
            "stopped",
            "Stopped: available RAM guard"
        ));
        assert!(!router_failure_waits_before_retry(
            "stopped",
            "Stopped by user"
        ));
        assert!(!router_failure_waits_before_retry(
            "stopped",
            "Process exited (0)"
        ));
    }

    fn installation_fixture(path: &Path) {
        fs::create_dir_all(path).unwrap();
        for name in ["zvram_manager.py", "zvram_model.py", "zvram"] {
            fs::write(path.join(name), "test").unwrap();
        }
    }

    #[test]
    fn request_is_typed_and_uses_the_python_bridge_field_names() {
        let request: ZvramRequest = serde_json::from_value(json!({
            "action": "save",
            "profile": "nx-demo",
            "model": "/models/demo.gguf",
            "alias": "demo",
            "port": 8097,
            "context": 4096,
            "compressed": false
        }))
        .unwrap();
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["action"], "save");
        assert_eq!(encoded["profile"], "nx-demo");
        assert_eq!(encoded["model"], "/models/demo.gguf");
        assert_eq!(encoded["port"], 8097);
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "save",
            "shell": "arbitrary command"
        }))
        .is_err());
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "unknown"
        }))
        .is_err());
    }

    #[test]
    fn router_request_and_swap_guard_field_are_typed() {
        let request: ZvramRequest = serde_json::from_value(json!({
            "action": "router_start",
            "port": 8097,
            "context": 8192,
            "compressed": true,
            "ignore_swap_guard": true,
            "live_control": true,
            "resident_mib": 12288,
            "cold_mib": 8192
        }))
        .unwrap();
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["action"], "router_start");
        assert_eq!(encoded["ignore_swap_guard"], true);
        assert_eq!(encoded["live_control"], true);
        assert_eq!(encoded["context"], 8192);
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "router_start",
            "ignore_swap_guard": "yes"
        }))
        .is_err());
    }

    #[test]
    fn router_ram_floor_is_optional_nonnegative_and_typed() {
        for floor in [0, 4096] {
            let request: ZvramRequest = serde_json::from_value(json!({
                "action": "router_start",
                "min_available_mib": floor
            }))
            .unwrap();
            let encoded = serde_json::to_value(request).unwrap();
            assert_eq!(encoded["min_available_mib"], floor);
        }
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "router_start",
            "min_available_mib": -1
        }))
        .is_err());
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "router_start",
            "min_available_mib": "0"
        }))
        .is_err());
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "router_start",
            "unrecognized": true
        }))
        .is_err());
        let status = serde_json::to_value(ZvramRequest::status()).unwrap();
        assert!(status.get("min_available_mib").is_none());
    }

    #[test]
    fn router_mode_configuration_is_typed() {
        let request: ZvramRequest = serde_json::from_value(json!({
            "action": "router_configure",
            "mode": "regular",
            "auto_start": false
        }))
        .unwrap();
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["mode"], "regular");
        assert_eq!(encoded["auto_start"], false);
        assert!(encoded.get("port").is_none());
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "router_configure",
            "auto_start": "yes"
        }))
        .is_err());
    }

    #[test]
    fn cached_inventory_is_forwarded_only_for_router_rebuilds() {
        for action in [ZvramAction::RouterStart, ZvramAction::RouterConfigure] {
            let request = ZvramRequest {
                action,
                ..ZvramRequest::status()
            };
            assert!(request_needs_cached_models(&request));
        }
        assert!(!request_needs_cached_models(&ZvramRequest::status()));
        let request = ZvramRequest {
            action: ZvramAction::RouterStop,
            ..ZvramRequest::status()
        };
        assert!(!request_needs_cached_models(&request));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn model_sync_service_is_checkout_owned_and_only_runs_watch_mode() {
        let unit = model_sync_unit_contents(
            Path::new("/srv/novum"),
            Path::new("/home/test/.local/share/novum-xenium/zvram/model-sync/v1/zvram_bridge.py"),
            Path::new("/home/test/.local/share/zvram/0.4.2"),
            Path::new("/home/test/.local/share/novum-xenium/cookies"),
            8123,
            Path::new("/srv/novum/data/huggingface"),
            Path::new("/home/test/.config/novum-xenium/zvram.json"),
        )
        .unwrap();
        assert!(unit.contains("# Novum-Checkout: /srv/novum\n"));
        assert!(unit.contains("ExecStart=/usr/bin/python3 -I \"/home/test/.local/share/novum-xenium/zvram/model-sync/v1/zvram_bridge.py\" watch "));
        assert!(unit.contains("\"/home/test/.local/share/zvram/0.4.2\" \"/srv/novum\" \"/home/test/.local/share/novum-xenium/cookies\" 8123 \"/srv/novum/data/huggingface\" 30 \"/home/test/.config/novum-xenium/zvram.json\""));
        assert!(unit.contains("UMask=0077\nNoNewPrivileges=true\nRestart=on-failure\n"));
        assert!(!unit.contains("After=default.target"));
        assert!(!unit.contains("router_start"));
        assert!(!unit.contains("router_stop"));
    }

    #[test]
    fn installation_requires_manager_model_helper_and_wrapper() {
        let temp = tempfile::tempdir().unwrap();
        installation_fixture(temp.path());
        assert_eq!(
            validate_installation(temp.path()).unwrap(),
            fs::canonicalize(temp.path()).unwrap()
        );
        fs::remove_file(temp.path().join("zvram_model.py")).unwrap();
        assert!(validate_installation(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn discovery_resolves_path_launcher_symlinks_and_skips_incomplete_installations() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let installation = temp.path().join("share/zvram/0.3.0");
        installation_fixture(&installation);
        let bin = temp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let launcher = bin.join("zvram");
        symlink(installation.join("zvram"), &launcher).unwrap();
        let incomplete = temp.path().join("incomplete");
        fs::create_dir_all(&incomplete).unwrap();
        fs::write(incomplete.join("zvram"), "wrapper only").unwrap();

        assert_eq!(
            find_installation([incomplete.join("zvram"), launcher]),
            Some(fs::canonicalize(installation).unwrap())
        );
        assert_eq!(find_installation([incomplete.join("zvram")]), None);
    }

    #[test]
    fn valid_manual_installation_wins_without_running_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let manual = temp.path().join("manual");
        let detected = temp.path().join("detected");
        installation_fixture(&manual);
        installation_fixture(&detected);
        let config = temp.path().join("config/zvram.json");
        save_installation(&config, &manual).unwrap();
        let mut discovery_called = false;

        let selected = read_or_detect_installation(&config, || {
            discovery_called = true;
            Some(detected)
        })
        .unwrap();

        assert_eq!(selected, Some(fs::canonicalize(manual).unwrap()));
        assert!(!discovery_called);
    }

    #[test]
    fn unconfigured_status_has_expected_empty_lists() {
        let result = unavailable_status("Choose an installation.");
        assert_eq!(result["available"], false);
        assert_eq!(result["models"], json!([]));
        assert_eq!(result["profiles"], json!([]));
        assert_eq!(result["message"], "Choose an installation.");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_library_path_filter_preserves_host_entries() {
        let appdir = Path::new("/tmp/test.AppDir");
        let inherited = OsStr::new(
            "/tmp/test.AppDir/usr/lib:/usr/lib/x86_64-linux-gnu:/opt/vulkan/lib:/tmp/test.AppDir2/lib",
        );
        let filtered = filtered_library_path(Some(appdir), inherited);
        assert_eq!(
            filtered,
            OsStr::new("/usr/lib/x86_64-linux-gnu:/opt/vulkan/lib:/tmp/test.AppDir2/lib")
        );
        assert_eq!(filtered_library_path(None, inherited), inherited);
    }
}
