use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};
use tauri::{AppHandle, State, WebviewWindow};

use super::{
    config_path, ensure_not_quitting, load_config_at, require_main, DesktopConfig, NativeState,
};

const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const ACTION_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
struct ImageModel {
    id: String,
    name: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
struct PendingModel {
    name: String,
    reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) struct ImageEngineStatus {
    available: bool,
    running: bool,
    healthy: bool,
    state: String,
    mode: String,
    effective_mode: Option<String>,
    auto_start: bool,
    idle_seconds: u64,
    loaded_model: Option<String>,
    generation_active: bool,
    #[serde(default)]
    models: Vec<ImageModel>,
    #[serde(default)]
    pending: Vec<PendingModel>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImageEngineAction {
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto_start: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    idle_seconds: Option<u64>,
}

impl ImageEngineAction {
    fn validate(&self) -> Result<(), String> {
        if !matches!(
            self.action.as_str(),
            "start" | "stop" | "refresh" | "configure"
        ) {
            return Err("Choose a supported image-engine action.".into());
        }
        if let Some(mode) = &self.mode {
            if !matches!(mode.as_str(), "auto" | "cpu" | "vulkan" | "zvram") {
                return Err("Choose Auto, CPU, Vulkan, or zVram mode.".into());
            }
        }
        if let Some(seconds) = self.idle_seconds {
            if !(30..=3_600).contains(&seconds) {
                return Err("Idle timeout must be between 30 and 3600 seconds.".into());
            }
        }
        Ok(())
    }
}

fn token_path(checkout: &Path) -> Result<std::path::PathBuf, String> {
    let checkout = fs::canonicalize(checkout)
        .map_err(|_| "The configured backend checkout is unavailable.".to_string())?;
    let dir = checkout.join("data/engine-manager");
    let metadata = fs::symlink_metadata(&dir)
        .map_err(|_| "The local image-engine access token is not ready yet.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The local image-engine token directory is not a safe directory.".into());
    }
    let resolved = fs::canonicalize(&dir)
        .map_err(|_| "The local image-engine token directory is unavailable.".to_string())?;
    if !resolved.starts_with(&checkout) {
        return Err(
            "The local image-engine token directory is outside the backend checkout.".into(),
        );
    }
    Ok(resolved.join("native.token"))
}

fn read_token(checkout: &Path) -> Result<String, String> {
    let path = token_path(checkout)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "The local image-engine access token is not ready yet.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4096 {
        return Err("The local image-engine access token is not a private regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("The local image-engine token file permissions are not private.".into());
        }
    }
    let token = fs::read_to_string(path)
        .map_err(|_| "The local image-engine access token cannot be read.".to_string())?;
    let token = token.trim();
    if token.is_empty() || token.len() > 2048 || token.contains(['\r', '\n']) {
        return Err("The local image-engine access token is invalid.".into());
    }
    Ok(token.to_string())
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "Could not prepare the local image-engine connection.".into())
}

async fn request<T: for<'de> Deserialize<'de>>(
    config: &DesktopConfig,
    method: reqwest::Method,
    action: Option<&ImageEngineAction>,
) -> Result<T, String> {
    let token = read_token(Path::new(&config.checkout))?;
    let url = format!("http://127.0.0.1:{}/api/local-engines/image", config.port);
    let timeout = if method == reqwest::Method::GET {
        STATUS_TIMEOUT
    } else {
        ACTION_TIMEOUT
    };
    let client = client(timeout)?;
    let mut builder = client
        .request(method, url)
        .header("X-Novum-Engine-Token", token);
    if let Some(action) = action {
        builder = builder.json(action);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "The local image-engine manager is not responding.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The local image-engine manager returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "The local image-engine manager returned an invalid status.".into())
}

async fn configured_backend(app: &AppHandle) -> Result<DesktopConfig, String> {
    let path = config_path(app)?;
    load_config_at(&path)?.ok_or_else(|| "Configure the local backend first.".into())
}

#[tauri::command]
pub(super) async fn image_engine_status(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<ImageEngineStatus, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    request(&configured_backend(&app).await?, reqwest::Method::GET, None).await
}

#[tauri::command]
pub(super) async fn image_engine_action(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
    action: ImageEngineAction,
) -> Result<ImageEngineStatus, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    action.validate()?;
    request(
        &configured_backend(&app).await?,
        reqwest::Method::POST,
        Some(&action),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread,
    };
    use tempfile::tempdir;

    fn sample_status() -> &'static str {
        r#"{"available":true,"running":false,"healthy":false,"state":"stopped","mode":"auto","effective_mode":null,"auto_start":true,"idle_seconds":300,"loaded_model":null,"generation_active":false,"models":[{"id":"sdxl","name":"SDXL","size_bytes":42}],"pending":[{"name":"FLUX","reason":"missing component"}]}"#
    }

    #[test]
    fn action_only_accepts_known_values_and_bounded_idle_time() {
        let action = ImageEngineAction {
            action: "configure".into(),
            mode: Some("vulkan".into()),
            auto_start: Some(true),
            idle_seconds: Some(300),
        };
        assert!(action.validate().is_ok());
        for seconds in [30, 3_600] {
            let boundary = ImageEngineAction {
                action: "configure".into(),
                mode: Some("auto".into()),
                auto_start: Some(false),
                idle_seconds: Some(seconds),
            };
            assert!(boundary.validate().is_ok());
        }
        let unsafe_action = ImageEngineAction {
            action: "exec".into(),
            mode: None,
            auto_start: None,
            idle_seconds: None,
        };
        assert!(unsafe_action.validate().is_err());
        let unsafe_mode = ImageEngineAction {
            action: "configure".into(),
            mode: Some("shell".into()),
            auto_start: None,
            idle_seconds: None,
        };
        assert!(unsafe_mode.validate().is_err());
        let too_short = ImageEngineAction {
            action: "configure".into(),
            mode: None,
            auto_start: None,
            idle_seconds: Some(29),
        };
        assert!(too_short.validate().is_err());
    }

    #[test]
    fn token_must_be_private_and_inside_checkout() {
        let root = tempdir().unwrap();
        let dir = root.path().join("data/engine-manager");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("native.token");
        fs::write(&path, "fixture-secret\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(read_token(root.path()).unwrap(), "fixture-secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read_token(root.path()).unwrap_err().contains("permissions"));
        }
        fs::remove_file(&path).unwrap();
        fs::write(&path, "replacement").unwrap();
        fs::remove_dir_all(&dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path(), &dir).unwrap();
        #[cfg(unix)]
        assert!(token_path(root.path())
            .unwrap_err()
            .contains("safe directory"));
    }

    #[test]
    fn local_status_request_sends_private_token_and_never_follows_redirects() {
        tauri::async_runtime::block_on(async {
            let root = tempdir().unwrap();
            let dir = root.path().join("data/engine-manager");
            fs::create_dir_all(&dir).unwrap();
            let token_path = dir.join("native.token");
            fs::write(&token_path, "fixture-secret").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = thread::spawn(move || {
                for method in ["GET", "POST"] {
                    let (stream, _) = listener.accept().unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut head = String::new();
                    let mut content_length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                        if let Some(value) =
                            line.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            content_length = value.trim().parse::<usize>().unwrap();
                        }
                        head.push_str(&line);
                    }
                    let mut body_bytes = vec![0; content_length];
                    reader.read_exact(&mut body_bytes).unwrap();
                    let request = head.to_ascii_lowercase();
                    assert!(request.starts_with(&format!(
                        "{method_lower} /api/local-engines/image http/1.1",
                        method_lower = method.to_ascii_lowercase()
                    )));
                    assert!(request.contains("x-novum-engine-token: fixture-secret"));
                    if method == "POST" {
                        let body = String::from_utf8(body_bytes).unwrap();
                        assert_eq!(
                            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
                            serde_json::json!({
                                "action":"configure", "mode":"vulkan", "auto_start":true, "idle_seconds":600
                            })
                        );
                    }
                    let body = sample_status();
                    let mut stream = stream;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }
            });
            let config = DesktopConfig {
                checkout: root.path().display().to_string(),
                port,
                project: "test".into(),
            };
            let result: ImageEngineStatus =
                request(&config, reqwest::Method::GET, None).await.unwrap();
            assert_eq!(result.models[0].id, "sdxl");
            assert_eq!(result.pending[0].name, "FLUX");
            let action = ImageEngineAction {
                action: "configure".into(),
                mode: Some("vulkan".into()),
                auto_start: Some(true),
                idle_seconds: Some(600),
            };
            let _: ImageEngineStatus = request(&config, reqwest::Method::POST, Some(&action))
                .await
                .unwrap();
            server.join().unwrap();
        });
    }
}
