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
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(super) struct ZvramRequest {
    action: ZvramAction,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    context: Option<u32>,
    #[serde(default)]
    compressed: Option<bool>,
    #[serde(default)]
    resident_mib: Option<u32>,
    #[serde(default)]
    cold_mib: Option<u32>,
    #[serde(default)]
    clean_cache_mib: Option<u32>,
    #[serde(default)]
    headroom_mib: Option<u32>,
    #[serde(default)]
    virtual_gib: Option<u32>,
    #[serde(default)]
    ignore_swap_guard: Option<bool>,
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
    let args = vec![
        "-I".to_string(),
        "-c".to_string(),
        BRIDGE.to_string(),
        installation.to_string_lossy().into_owned(),
        backend.checkout,
        cookie_path.to_string_lossy().into_owned(),
        backend.port.to_string(),
        request_json,
    ];
    let env = bridge_environment();
    let output =
        super::run_command_env("python3", &args, Some(installation), COMMAND_TIMEOUT, &env)?;
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

fn filtered_library_path(appdir: Option<&Path>, value: &OsStr) -> OsString {
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
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "zVram operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let Some(selected) = rfd::FileDialog::new().pick_folder() else {
            return Ok(None);
        };
        let checkout = validate_installation(&selected)?;
        save_installation(&path, &checkout).map(Some)
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
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "zVram operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        run_bridge(&app, &installation, &request)
    })
    .await
    .map_err(|e| format!("zVram action worker failed: {e}"))?
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
            ignore_swap_guard: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "resident_mib": 12288,
            "cold_mib": 8192
        }))
        .unwrap();
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["action"], "router_start");
        assert_eq!(encoded["ignore_swap_guard"], true);
        assert_eq!(encoded["context"], 8192);
        assert!(serde_json::from_value::<ZvramRequest>(json!({
            "action": "router_start",
            "ignore_swap_guard": "yes"
        }))
        .is_err());
    }

    #[test]
    fn installation_requires_manager_model_helper_and_wrapper() {
        let temp = tempfile::tempdir().unwrap();
        installation_fixture(temp.path());
        assert_eq!(validate_installation(temp.path()).unwrap(), temp.path());
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
