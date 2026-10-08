use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri::{
    path::BaseDirectory, AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const DEFAULT_PROJECT: &str = "odysseus-local";
const COMMAND_OUTPUT_LIMIT: usize = 128 * 1024;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    checkout: String,
    port: u16,
    project: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendStatus {
    state: String,
    url: Option<String>,
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    config: Option<DesktopConfig>,
    backend: BackendStatus,
    update: UpdateAvailability,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAvailability {
    supported: bool,
    current: Option<String>,
    target: Option<String>,
    available: bool,
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogResult {
    text: String,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
struct WorkbenchResult {
    url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateResult {
    updated: bool,
    from: String,
    to: Option<String>,
    backup_path: Option<String>,
    rolled_back: bool,
    detail: String,
}

#[derive(Default)]
struct NativeState {
    operation: Arc<Mutex<()>>,
    workbench_port: Arc<std::sync::atomic::AtomicU16>,
    last_workbench_notification: Mutex<Option<Instant>>,
    tray_created: AtomicBool,
    tray_icon: Mutex<Option<TrayIcon>>,
    quit_pending: Arc<AtomicBool>,
}

#[derive(Debug)]
struct CommandOutput {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Native manager commands are only available to the main window.".into())
    }
}

fn ensure_not_quitting(pending: &AtomicBool) -> Result<(), String> {
    if pending.load(Ordering::Acquire) {
        Err("The app is finishing its current operation before quitting.".into())
    } else {
        Ok(())
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("config.json", BaseDirectory::AppConfig)
        .map_err(|e| format!("Cannot resolve app configuration directory: {e}"))
}

fn load_config_at(path: &Path) -> Result<Option<DesktopConfig>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let config: DesktopConfig = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Saved configuration is invalid: {e}"))?;
            validate_config(config).map(Some)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read saved configuration: {e}")),
    }
}

fn validate_config(mut config: DesktopConfig) -> Result<DesktopConfig, String> {
    let checkout = fs::canonicalize(&config.checkout)
        .map_err(|_| "Choose an existing Odysseus checkout directory.".to_string())?;
    if !checkout.is_dir() || !checkout.join("docker-compose.yml").is_file() {
        return Err("The selected directory must contain docker-compose.yml.".into());
    }
    for name in ["docker.local.yml", "docker.host-local.yml"] {
        let file = checkout.join(name);
        if file.exists()
            && (!file.is_file() || file.canonicalize().ok().as_deref() != Some(file.as_path()))
        {
            return Err(format!(
                "Optional Compose file {name} must be a regular file inside the checkout."
            ));
        }
    }
    if config.port == 0 {
        return Err("Port must be between 1 and 65535.".into());
    }
    if config.project.trim().is_empty() {
        config.project = DEFAULT_PROJECT.into();
    }
    if config.project.len() > 63
        || !config.project.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || (i > 0 && c == b'-')
                || (i > 0 && c == b'_')
        })
        || !config.project.as_bytes()[0].is_ascii_lowercase()
            && !config.project.as_bytes()[0].is_ascii_digit()
    {
        return Err("Project must start with a lowercase letter or digit and use only lowercase letters, digits, hyphens, and underscores.".into());
    }
    config.checkout = checkout.to_string_lossy().into_owned();
    Ok(config)
}

fn save_config_at(path: &Path, config: DesktopConfig) -> Result<DesktopConfig, String> {
    let config = validate_config(config)?;
    let parent = path
        .parent()
        .ok_or("Configuration path has no parent directory.")?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Cannot create configuration directory: {e}"))?;
    let temp = parent.join(format!("config.json.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&temp, bytes).map_err(|e| format!("Cannot write configuration: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Cannot protect configuration file: {e}"))?;
    }
    fs::rename(&temp, path).map_err(|e| format!("Cannot save configuration: {e}"))?;
    Ok(config)
}

fn compose_args(config: &DesktopConfig, args: &[&str]) -> (PathBuf, Vec<String>) {
    let checkout = PathBuf::from(&config.checkout);
    let mut full = vec![
        "compose".into(),
        "-p".into(),
        config.project.clone(),
        "-f".into(),
        "docker-compose.yml".into(),
    ];
    for file in ["docker.local.yml", "docker.host-local.yml"] {
        if checkout.join(file).is_file() {
            full.extend(["-f".into(), file.into()]);
        }
    }
    full.extend(args.iter().map(|s| (*s).to_string()));
    (checkout, full)
}

fn capture_tail<R: Read>(mut reader: R, limit: usize) -> (Vec<u8>, bool) {
    let mut tail = Vec::with_capacity(limit.min(8192));
    let mut buf = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if n >= limit {
                    tail.clear();
                    tail.extend_from_slice(&buf[n - limit..n]);
                    truncated = true;
                } else {
                    let excess = tail.len().saturating_add(n).saturating_sub(limit);
                    if excess > 0 {
                        tail.drain(..excess);
                        truncated = true;
                    }
                    tail.extend_from_slice(&buf[..n]);
                }
            }
        }
    }
    (tail, truncated)
}

fn run_command(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    run_command_env(program, args, cwd, timeout, &[])
}

fn run_command_env(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    env: &[(&str, String)],
) -> Result<CommandOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {program}: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_done = Arc::new(AtomicBool::new(false));
    let err_done = Arc::new(AtomicBool::new(false));
    let out_reader = {
        let done = out_done.clone();
        thread::spawn(move || {
            let captured = capture_tail(stdout, COMMAND_OUTPUT_LIMIT);
            done.store(true, Ordering::Release);
            captured
        })
    };
    let err_reader = {
        let done = err_done.clone();
        thread::spawn(move || {
            let captured = capture_tail(stderr, COMMAND_OUTPUT_LIMIT);
            done.store(true, Ordering::Release);
            captured
        })
    };
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Err(e) => {
                stop_owned_process(&mut child);
                let _ = child.wait();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(format!("Could not wait for {program}: {e}"));
            }
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() >= timeout => {
                stop_owned_process(&mut child);
                let _ = child.wait();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(format!(
                    "{program} exceeded its {} second time limit.",
                    timeout.as_secs()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    };
    let readers_end = Instant::now() + Duration::from_secs(1);
    while (!out_done.load(Ordering::Acquire) || !err_done.load(Ordering::Acquire))
        && Instant::now() < readers_end
    {
        thread::sleep(Duration::from_millis(20));
    }
    if !out_done.load(Ordering::Acquire) || !err_done.load(Ordering::Acquire) {
        stop_owned_process(&mut child);
        let _ = out_reader.join();
        let _ = err_reader.join();
        return Err(format!("{program} left an output-producing child running."));
    }
    let (stdout, out_truncated) = out_reader
        .join()
        .map_err(|_| format!("{program} output reader failed."))?;
    let (stderr, err_truncated) = err_reader
        .join()
        .map_err(|_| format!("{program} error reader failed."))?;
    Ok(CommandOutput {
        code: status.code(),
        stdout,
        stderr,
        truncated: out_truncated || err_truncated,
    })
}

fn stop_owned_process(child: &mut std::process::Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        let group = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
        thread::sleep(Duration::from_millis(200));
        let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
        let _ = child.kill();
    }
}

fn run_compose(
    config: &DesktopConfig,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let (checkout, args) = compose_args(config, args);
    run_command_env(
        "docker",
        &args,
        Some(&checkout),
        timeout,
        &[
            ("APP_PORT", config.port.to_string()),
            ("APP_BIND", "127.0.0.1".into()),
        ],
    )
}

fn command_ok(output: &CommandOutput, operation: &str) -> Result<(), String> {
    if output.code == Some(0) {
        Ok(())
    } else {
        Err(format!(
            "{operation} failed (exit code {}). See backend logs for details.",
            output.code.map_or("unknown".into(), |c| c.to_string())
        ))
    }
}

fn app_url(config: &DesktopConfig) -> String {
    format!("http://127.0.0.1:{}/", config.port)
}

fn health_check(config: &DesktopConfig) -> bool {
    if !compose_publishes_app_port(config) {
        return false;
    }
    let address = ("127.0.0.1", config.port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = address else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(
            format!(
                "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                config.port
            )
            .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    let mut first_line = String::new();
    if std::io::BufReader::new(stream)
        .read_line(&mut first_line)
        .is_err()
    {
        return false;
    }
    first_line.contains(" 200 ")
}

fn loopback_port_matches(output: &str, expected: u16) -> bool {
    output.lines().any(|line| {
        line.trim()
            .parse::<std::net::SocketAddr>()
            .is_ok_and(|address| address.ip().is_loopback() && address.port() == expected)
    })
}

fn compose_publishes_app_port(config: &DesktopConfig) -> bool {
    if run_compose(
        config,
        &["port", "odysseus", "7000"],
        Duration::from_secs(10),
    )
    .is_ok_and(|output| {
        output.code == Some(0)
            && !output.truncated
            && loopback_port_matches(&String::from_utf8_lossy(&output.stdout), config.port)
    }) {
        return true;
    }
    host_network_backend_matches(config)
}

fn host_network_command_matches(network: &str, command: &[String], port: u16) -> bool {
    if network != "host" || command.first().map(String::as_str) != Some("uvicorn") {
        return false;
    }
    let host = command
        .windows(2)
        .find(|args| args[0] == "--host")
        .map(|args| args[1].as_str());
    let command_port = command
        .windows(2)
        .find(|args| args[0] == "--port")
        .and_then(|args| args[1].parse::<u16>().ok());
    host.is_some_and(|host| {
        host.parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
    }) && command_port == Some(port)
}

fn host_network_backend_matches(config: &DesktopConfig) -> bool {
    let output = match run_compose(config, &["ps", "-q", "odysseus"], Duration::from_secs(10)) {
        Ok(output) if output.code == Some(0) && !output.truncated => output,
        _ => return false,
    };
    let ids = String::from_utf8_lossy(&output.stdout);
    let mut ids = ids.split_whitespace();
    let Some(id) = ids.next() else { return false };
    if ids.next().is_some() || id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let network = run_command(
        "docker",
        &[
            "inspect".into(),
            "--format".into(),
            "{{json .HostConfig.NetworkMode}}".into(),
            id.into(),
        ],
        None,
        Duration::from_secs(10),
    );
    let command = run_command(
        "docker",
        &[
            "inspect".into(),
            "--format".into(),
            "{{json .Config.Cmd}}".into(),
            id.into(),
        ],
        None,
        Duration::from_secs(10),
    );
    let (Ok(network), Ok(command)) = (network, command) else {
        return false;
    };
    if network.code != Some(0) || command.code != Some(0) || network.truncated || command.truncated
    {
        return false;
    }
    let network: Result<String, _> = serde_json::from_slice(&network.stdout);
    let command: Result<Vec<String>, _> = serde_json::from_slice(&command.stdout);
    network
        .ok()
        .zip(command.ok())
        .is_some_and(|(network, command)| {
            host_network_command_matches(&network, &command, config.port)
        })
}

fn probe_health(config: &DesktopConfig) -> bool {
    probe_health_for(config, HEALTH_TIMEOUT)
}

fn probe_health_for(config: &DesktopConfig, timeout: Duration) -> bool {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if health_check(config) {
            return true;
        }
        thread::sleep(
            end.saturating_duration_since(Instant::now())
                .min(Duration::from_secs(2)),
        );
    }
    false
}

fn running_state(config: &DesktopConfig) -> Result<bool, String> {
    let output = run_compose(
        config,
        &["ps", "--services", "--status", "running"],
        Duration::from_secs(15),
    )?;
    command_ok(&output, "Compose status")?;
    Ok(running_services_include_odysseus(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn running_services_include_odysseus(output: &str) -> bool {
    output.lines().any(|service| service.trim() == "odysseus")
}

fn status_for(config: Option<DesktopConfig>) -> DesktopStatus {
    let Some(config) = config else {
        return DesktopStatus {
            config: None,
            backend: BackendStatus {
                state: "unconfigured".into(),
                url: None,
                detail: None,
            },
            update: UpdateAvailability {
                supported: true,
                current: None,
                target: None,
                available: false,
                detail: None,
            },
        };
    };
    let url = app_url(&config);
    let (state, detail) = match running_state(&config) {
        Ok(false) => ("stopped".into(), None),
        Ok(true) if health_check(&config) => ("running".into(), None),
        Ok(true) => (
            "unhealthy".into(),
            Some("Compose is running, but the local health endpoint did not respond.".into()),
        ),
        Err(_) => (
            "error".into(),
            Some("Could not read the saved Compose project status.".into()),
        ),
    };
    DesktopStatus {
        config: Some(config),
        backend: BackendStatus {
            state,
            url: Some(url),
            detail,
        },
        update: UpdateAvailability {
            supported: true,
            current: None,
            target: None,
            available: false,
            detail: Some("Run the update check to inspect the configured checkout.".into()),
        },
    }
}

#[tauri::command]
async fn get_status(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<DesktopStatus, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let config = load_config_at(&path)?;
        Ok(status_for(config))
    })
    .await
    .map_err(|e| format!("Status worker failed: {e}"))?
}

#[tauri::command]
async fn save_config(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
    config: DesktopConfig,
) -> Result<DesktopConfig, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        if let Some(existing) = load_config_at(&path)? {
            let proposed = validate_config(config.clone())?;
            if existing != proposed && running_state(&existing)? {
                return Err(
                    "Stop the configured backend before changing its checkout, project, or port."
                        .into(),
                );
            }
        }
        save_config_at(&path, config)
    })
    .await
    .map_err(|e| format!("Configuration worker failed: {e}"))?
}

#[tauri::command]
async fn start_backend(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<DesktopStatus, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let config = load_config_at(&path)?.ok_or("Save a trusted checkout before starting the backend.")?;
        let output = run_compose(&config, &["up", "-d", "--build"], Duration::from_secs(1200))?;
        command_ok(&output, "Backend start")?;
        if !probe_health(&config) {
            return Err("Compose started, but the local health endpoint did not become ready within three minutes.".into());
        }
        Ok(status_for(Some(config)))
    }).await.map_err(|e| format!("Backend start worker failed: {e}"))?
}

#[tauri::command]
async fn stop_backend(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<DesktopStatus, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let config = load_config_at(&path)?.ok_or("No checkout is configured.")?;
        let output = run_compose(
            &config,
            &["stop", "--timeout", "30"],
            Duration::from_secs(60),
        )?;
        command_ok(&output, "Backend stop")?;
        Ok(status_for(Some(config)))
    })
    .await
    .map_err(|e| format!("Backend stop worker failed: {e}"))?
}

#[tauri::command]
async fn read_logs(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<LogResult, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let config = load_config_at(&path)?.ok_or("No checkout is configured.")?;
        let output = run_compose(
            &config,
            &["logs", "--no-color", "--tail", "500"],
            Duration::from_secs(30),
        )?;
        command_ok(&output, "Read backend logs")?;
        Ok(LogResult {
            text: String::from_utf8_lossy(&output.stdout).into_owned(),
            truncated: output.truncated,
        })
    })
    .await
    .map_err(|e| format!("Log worker failed: {e}"))?
}

fn workbench_origin_allowed(url: &tauri::Url, port: u16) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url
            .host_str()
            .is_some_and(|host| matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]"))
        && url.port_or_known_default() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

fn workbench_window_action(url: &tauri::Url) -> Option<&str> {
    if url.scheme() != "nx-workbench"
        || !matches!(url.path(), "" | "/")
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.host_str().filter(|action| {
        matches!(
            *action,
            "ready" | "drag" | "minimize" | "toggle-maximize" | "close" | "native-frame"
        )
    })
}

#[derive(Debug, PartialEq, Eq)]
struct WorkbenchNotification {
    title: String,
    body: String,
}

fn workbench_notification(url: &tauri::Url) -> Option<WorkbenchNotification> {
    let authority = url
        .as_str()
        .strip_prefix("nx-workbench://")?
        .split(['/', '?', '#'])
        .next()?;
    if url.scheme() != "nx-workbench"
        || url.host_str() != Some("notify")
        || url.port().is_some()
        || !url.path().is_empty()
        || url.fragment().is_some()
        || authority.contains('@')
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }

    let query = url.query()?;
    if query.split('&').count() != 2 {
        return None;
    }
    let mut title = None;
    let mut body = None;
    for (key, value) in url.query_pairs() {
        let target = match key.as_ref() {
            "title" if title.is_none() => &mut title,
            "body" if body.is_none() => &mut body,
            _ => return None,
        };
        *target = Some(value.into_owned());
    }
    let title = title?;
    let body = body?;
    if query.is_empty()
        || title.trim().is_empty()
        || title.chars().count() > 120
        || body.chars().count() > 500
    {
        return None;
    }
    Some(WorkbenchNotification { title, body })
}

fn allow_workbench_notification(state: &NativeState) -> bool {
    let mut last = state
        .last_workbench_notification
        .lock()
        .expect("notification throttle lock poisoned");
    let now = Instant::now();
    if last.is_some_and(|previous| now.duration_since(previous) < Duration::from_secs(1)) {
        return false;
    }
    *last = Some(now);
    true
}

fn workbench_control_origin_allowed(url: &tauri::Url, port: u16) -> bool {
    // Match app_url exactly, even though the pre-existing navigation policy
    // accepts loopback aliases. Embedded providers never get this bridge.
    workbench_origin_allowed(url, port)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
}

fn browser_url_allowed(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn workbench_blob_allowed(url: &tauri::Url, port: u16) -> bool {
    // Let WebKit process <a download> blobs produced by this exact backend.
    // They never go to the external opener or receive native manager access.
    url.scheme() == "blob"
        && url
            .as_str()
            .strip_prefix("blob:")
            .and_then(|inner| inner.parse::<tauri::Url>().ok())
            .is_some_and(|inner| workbench_control_origin_allowed(&inner, port))
}

fn safe_download_name(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let mut safe = String::new();
    for character in name.chars() {
        let character = if character.is_control() || "<>:\"/\\|?*".contains(character) {
            '_'
        } else {
            character
        };
        if safe.len() + character.len_utf8() > 180 {
            break;
        }
        safe.push(character);
    }
    let safe = safe.trim().trim_matches('.').trim();
    let stem = safe.split('.').next().unwrap_or("").to_ascii_uppercase();
    if safe.is_empty()
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return "download".into();
    }
    safe.to_owned()
}

#[cfg(target_os = "linux")]
fn download_workbench_blob(window: &WebviewWindow, url: String) {
    let owner = window.clone();
    let _ = window.with_webview(move |webview| {
        use std::{
            cell::{Cell, RefCell},
            rc::Rc,
        };
        use webkit2gtk::{DownloadExt, URIResponseExt, WebViewExt};
        let Some(download) = webview.inner().download_uri(&url) else {
            workbench_notice(&owner, "Could not start this image download.");
            return;
        };
        // WebKit blob requests have no URI; Wry skips its download callback.
        // Handle this one returned download directly, without page IPC access.
        let selected = Rc::new(RefCell::new(None::<PathBuf>));
        let failed = Rc::new(Cell::new(false));
        let destination = selected.clone();
        let chooser_owner = owner.clone();
        download.connect_decide_destination(move |download, name| {
            let fallback = match download.response().and_then(|r| r.mime_type()).as_deref() {
                Some("image/png") => "image.png",
                Some("image/jpeg") => "image.jpg",
                Some("image/webp") => "image.webp",
                Some("application/zip") => "download.zip",
                Some("application/json") => "download.json",
                _ => "download",
            };
            let mut dialog = rfd::FileDialog::new()
                .set_title("Save file")
                .set_file_name(safe_download_name(Path::new(if name.is_empty() {
                    fallback
                } else {
                    name
                })))
                .set_parent(&chooser_owner);
            if let Ok(directory) = chooser_owner.app_handle().path().download_dir() {
                dialog = dialog.set_directory(directory);
            }
            match dialog.save_file() {
                Some(path) if path.is_absolute() => {
                    download.set_destination(&path.to_string_lossy());
                    *destination.borrow_mut() = Some(path);
                }
                _ => {
                    download.cancel();
                    workbench_notice(&chooser_owner, "Save cancelled.");
                }
            }
            true
        });
        let failed_flag = failed.clone();
        download.connect_failed(move |_, _| failed_flag.set(true));
        download.connect_finished(move |_| {
            if let Some(path) = selected.borrow().as_ref() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                workbench_notice(
                    &owner,
                    &if failed.get() {
                        format!("Could not save {name}. Check the destination and try again.")
                    } else {
                        format!("Saved {name}.")
                    },
                );
            }
        });
    });
}

fn workbench_notice(window: &WebviewWindow, message: &str) {
    // textContent + JSON serialization keep filenames/URLs out of executable JS.
    let message =
        serde_json::to_string(message).unwrap_or_else(|_| "\"Desktop action failed\"".into());
    let _ = window.eval(&format!(r#"(() => {{
        document.getElementById('nx-desktop-notice')?.remove();
        const notice=document.createElement('div'); notice.id='nx-desktop-notice'; notice.role='status';
        notice.textContent={message};
        notice.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:80vw;padding:12px 16px;border:2px solid var(--border,#554466);border-radius:10px;background:var(--bg,#17151b);color:var(--fg,#eee);font:13px sans-serif';
        document.body.append(notice);setTimeout(()=>notice.remove(),8000);
    }})()"#));
}

fn open_workbench_browser(app: &AppHandle, url: &tauri::Url) {
    if !browser_url_allowed(url) {
        if let Some(window) = app.get_webview_window("workbench") {
            workbench_notice(
                &window,
                if matches!(url.scheme(), "blob" | "data") {
                    "Save this image first. Embedded image addresses cannot open in your external browser."
                } else {
                    "Only HTTP and HTTPS links can open in your external browser."
                },
            );
        }
        return;
    }
    let app = app.clone();
    let url = url.to_string();
    thread::spawn(move || {
        if let Err(error) = open::that(&url) {
            eprintln!("Cannot open default browser: {error}");
            if let Some(window) = app.get_webview_window("workbench") {
                workbench_notice(
                    &window,
                    "Could not open your default browser. Check your system browser setting.",
                );
            }
        }
    });
}

fn update_workbench_chrome(window: &WebviewWindow) {
    if let Ok(maximized) = window.is_maximized() {
        let _ = window.eval(&format!(
            "document.documentElement.dataset.nxMaximized='{maximized}';"
        ));
    }
}

fn handle_workbench_window_action(window: &WebviewWindow, action: &str) -> tauri::Result<()> {
    match action {
        "ready" if !cfg!(target_os = "macos") => {
            window.set_decorations(false)?;
            // If injection cannot complete, immediately retain native controls.
            if let Err(error) =
                window.eval("document.documentElement.dataset.nxWindowFrame='custom';")
            {
                let _ = window.set_decorations(true);
                return Err(error);
            }
            update_workbench_chrome(window);
        }
        "native-frame" | "ready" => {
            window.set_decorations(true)?;
            let _ = window.eval("document.documentElement.dataset.nxWindowFrame='native';");
        }
        "drag" => window.start_dragging()?,
        "minimize" => window.minimize()?,
        "toggle-maximize" => {
            if window.is_maximized()? {
                window.unmaximize()?;
            } else {
                window.maximize()?;
            }
        }
        // close() retains the existing CloseRequested / hide-to-tray behavior.
        "close" => window.close()?,
        _ => {}
    }
    Ok(())
}

fn open_saved_workbench(app: &AppHandle, state: &NativeState) -> Result<WorkbenchResult, String> {
    let path = config_path(&app)?;
    let config = load_config_at(&path)?.ok_or("Save a checkout before opening the workbench.")?;
    let url = app_url(&config);
    let parsed = url
        .parse()
        .map_err(|e| format!("Invalid workbench URL: {e}"))?;
    if let Some(existing) = app.get_webview_window("workbench") {
        let old_port = state.workbench_port.load(Ordering::Acquire);
        if old_port != config.port
            || existing
                .url()
                .map_or(true, |url| !workbench_origin_allowed(&url, config.port))
        {
            state.workbench_port.store(config.port, Ordering::Release);
            if let Err(error) = existing.navigate(parsed) {
                state.workbench_port.store(old_port, Ordering::Release);
                return Err(format!("Cannot navigate workbench: {error}"));
            }
        }
        existing
            .show()
            .map_err(|e| format!("Cannot show workbench: {e}"))?;
        existing
            .unminimize()
            .map_err(|e| format!("Cannot restore workbench: {e}"))?;
        existing
            .set_focus()
            .map_err(|e| format!("Cannot focus workbench: {e}"))?;
        return Ok(WorkbenchResult { url });
    }
    state.workbench_port.store(config.port, Ordering::Release);
    let allowed_port = state.workbench_port.clone();
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let downloads = Arc::new(Mutex::new(HashMap::<String, Vec<Option<PathBuf>>>::new()));
    WebviewWindowBuilder::new(app, "workbench", WebviewUrl::External(parsed))
        .title("Novum Xenium Workbench")
        .initialization_script(include_str!("workspace_reload.js"))
        .initialization_script(include_str!("workspace_chrome.js"))
        .initialization_script(include_str!("workspace_notifications.js"))
        .initialization_script(include_str!("workspace_image_actions.js"))
        .enable_clipboard_access()
        .inner_size(1360.0, 900.0)
        .on_new_window(move |url, _features| {
            open_workbench_browser(&popup_app, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(move |webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    let native_window = webview.window();
                    let mut dialog = rfd::FileDialog::new().set_title("Save file")
                        .set_file_name(safe_download_name(destination)).set_parent(&native_window);
                    if let Ok(directory) = webview.app_handle().path().download_dir() {
                        dialog = dialog.set_directory(directory);
                    }
                    match dialog.save_file() {
                        Some(selected) if selected.is_absolute() => {
                            downloads.lock().expect("download lock poisoned")
                                .entry(url.to_string()).or_default().push(Some(selected.clone()));
                            *destination = selected;
                        }
                        _ => {
                            downloads.lock().expect("download lock poisoned")
                                .entry(url.to_string()).or_default().push(None);
                            if let Some(window) = webview.app_handle().get_webview_window("workbench") {
                                workbench_notice(&window, "Save cancelled.");
                            }
                            return false;
                        }
                    }
                }
                tauri::webview::DownloadEvent::Finished { url, path, success } => {
                    let mut pending = downloads.lock().expect("download lock poisoned");
                    let selected = pending.get_mut(url.as_str()).and_then(|paths| {
                        if paths.is_empty() { return None; }
                        let index = path.as_ref().and_then(|completed| paths.iter()
                            .position(|chosen| chosen.as_ref() == Some(completed))).unwrap_or(0);
                        paths.remove(index)
                    });
                    if pending.get(url.as_str()).is_some_and(Vec::is_empty) { pending.remove(url.as_str()); }
                    drop(pending);
                    // Cancellations have no chosen destination and need no failure toast.
                    if let Some(selected) = selected {
                        let selected = path.unwrap_or(selected);
                        let name = selected.file_name().unwrap_or_default().to_string_lossy();
                        let message = if success {
                            format!("Saved {name}.")
                        } else if selected.is_file() {
                            // WebKit/Wry can retain a cancelled download's failed flag.
                            // Existence alone cannot prove integrity, so report uncertainty.
                            format!("Download ended with a browser warning. Check {name} before using it.")
                        } else {
                            format!("Could not save {name}. Check the destination and try again.")
                        };
                        if let Some(window) = webview.app_handle().get_webview_window("workbench") {
                            workbench_notice(&window, &message);
                        }
                    }
                }
                _ => {}
            }
            true
        })
        .on_navigation(move |next| {
            let port = allowed_port.load(Ordering::Acquire);
            if next.scheme() == "nx-workbench" {
                if let Some(window) = navigation_app.get_webview_window("workbench") {
                    // This custom URL route is available only to the currently validated
                    // local backend. It grants no Tauri IPC or general native commands.
                    if window
                        .url()
                        .is_ok_and(|url| workbench_control_origin_allowed(&url, port))
                    {
                        if let Some(notification) = workbench_notification(next) {
                            let state = navigation_app.state::<NativeState>();
                            if allow_workbench_notification(&state) {
                                use tauri_plugin_notification::NotificationExt;
                                if navigation_app
                                    .notification()
                                    .builder()
                                    .title(&notification.title)
                                    .body(&notification.body)
                                    .show()
                                    .is_err()
                                {
                                    workbench_notice(
                                        &window,
                                        "Could not show the desktop notification.",
                                    );
                                }
                            }
                        } else if let Some(action) = workbench_window_action(next) {
                            if let Err(error) = handle_workbench_window_action(&window, action) {
                                eprintln!("Workspace window action {action} failed: {error}");
                                let _ = window.set_decorations(true);
                                let _ = window.eval(
                                    "document.documentElement.dataset.nxWindowFrame='native';",
                                );
                            }
                        }
                    }
                }
                return false;
            }
            if workbench_blob_allowed(next, port) {
                #[cfg(target_os = "linux")]
                {
                    // Wry's GTK navigation callback forces policy.use(), which
                    // bypasses <a download>. Start this same-view blob download
                    // explicitly instead of navigating away from the workspace.
                    if let Some(window) = navigation_app.get_webview_window("workbench") {
                        download_workbench_blob(&window, next.to_string());
                    }
                    return false;
                }
                #[cfg(not(target_os = "linux"))]
                { return true; }
            }
            if workbench_origin_allowed(next, port) { return true; }
            if browser_url_allowed(next) { open_workbench_browser(&navigation_app, next); }
            false
        })
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                // Failed loads still have usable OS controls, even before JS mounts.
                let _ = window.set_decorations(true);
                let _ = window.eval("document.documentElement.dataset.nxWindowFrame='native';");
            }
        })
        .build()
        .map_err(|e| format!("Cannot open workbench: {e}"))?;
    Ok(WorkbenchResult { url })
}

#[tauri::command]
fn open_workbench(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<WorkbenchResult, String> {
    require_main(&window)?;
    open_saved_workbench(&app, &state)
}

fn show_manager(app: &AppHandle) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        if window.show().is_err() {
            return false;
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
        true
    } else {
        false
    }
}

fn restore_workspace(app: &AppHandle) {
    let state = app.state::<NativeState>();
    if let Err(error) = open_saved_workbench(app, &state) {
        eprintln!("Cannot open workbench from tray: {error}");
        show_manager(app);
    }
}

fn quit_when_idle(app: &AppHandle) {
    let state = app.state::<NativeState>();
    if state.quit_pending.swap(true, Ordering::AcqRel) {
        show_quit_pending_notice(app);
        return;
    }
    let operation = state.operation.clone();
    let wait_for_operation = operation.clone();
    match operation.try_lock() {
        Ok(_guard) => app.exit(0),
        Err(_) => {
            show_quit_pending_notice(app);
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = wait_for_operation
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                app.exit(0);
            });
        }
    };
}

fn show_quit_pending_notice(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.eval(
            "(() => { const notice = document.getElementById('global-notice'); if (notice) { notice.textContent = 'Finishing the current backend operation before quitting…'; notice.hidden = false; } })()",
        );
        let _ = window.set_focus();
    }
}

fn install_tray(app: &AppHandle) -> Result<TrayIcon, String> {
    let workspace = MenuItem::with_id(app, "open-workspace", "Open workspace", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let reload = MenuItem::with_id(
        app,
        "reload-workspace",
        "Reload workspace",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let manager = MenuItem::with_id(
        app,
        "backend-manager",
        "Backend manager",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&workspace, &reload, &manager, &quit])
        .map_err(|error| error.to_string())?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Novum Xenium")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-workspace" => restore_workspace(app),
            "reload-workspace" => {
                if let Some(window) = app.get_webview_window("workbench") {
                    if let Err(error) = window.reload() {
                        eprintln!("Cannot reload workspace: {error}");
                    }
                } else {
                    restore_workspace(app);
                }
            }
            "backend-manager" => {
                show_manager(app);
            }
            "quit" => quit_when_idle(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore_workspace(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|error| error.to_string())
}

fn tray_host_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(connection) = zbus::blocking::Connection::session() else {
            return false;
        };
        let Ok(proxy) = zbus::blocking::fdo::DBusProxy::new(&connection) else {
            return false;
        };
        let Ok(watcher_name) = "org.kde.StatusNotifierWatcher".try_into() else {
            return false;
        };
        proxy.name_has_owner(watcher_name).unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn can_hide_to_tray(tray_created: bool, host_available: bool) -> bool {
    tray_created && host_available
}

#[tauri::command]
async fn check_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<UpdateAvailability, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let config = load_config_at(&path)?.ok_or("No checkout is configured.")?;
        check_update_inner(&config)
    })
    .await
    .map_err(|e| format!("Update check worker failed: {e}"))?
}

fn check_update_inner(config: &DesktopConfig) -> Result<UpdateAvailability, String> {
    let current = git(config, &["rev-parse", "HEAD"])?;
    let fetch = git_output(config, &["fetch", "origin"], Duration::from_secs(180))?;
    command_ok(&fetch, "Fetch updates")?;
    let target = git(config, &["rev-parse", "refs/remotes/origin/HEAD"])?;
    ensure_clean_checkout(config, Some(&target))?;
    let ancestry = run_command(
        "git",
        &[
            "merge-base".into(),
            "--is-ancestor".into(),
            current.clone(),
            target.clone(),
        ],
        Some(Path::new(&config.checkout)),
        Duration::from_secs(15),
    )?;
    let available = ancestry.code == Some(0) && current != target;
    let divergent = ancestry.code != Some(0) && current != target;
    Ok(UpdateAvailability {
        supported: true,
        current: Some(current),
        target: Some(target),
        available,
        detail: divergent.then(|| {
            "The checkout is not behind origin/HEAD; update requires a manual Git review.".into()
        }),
    })
}

fn git(config: &DesktopConfig, args: &[&str]) -> Result<String, String> {
    let output = git_output(config, args, Duration::from_secs(20))?;
    command_ok(&output, "Git operation")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_output(
    config: &DesktopConfig,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandOutput, String> {
    run_command(
        "git",
        &args.iter().map(|s| (*s).to_string()).collect::<Vec<_>>(),
        Some(Path::new(&config.checkout)),
        timeout,
    )
}

#[tauri::command]
async fn update_backend(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeState>,
) -> Result<UpdateResult, String> {
    require_main(&window)?;
    ensure_not_quitting(&state.quit_pending)?;
    let path = config_path(&app)?;
    let lock = state.operation.clone();
    let quit_pending = state.quit_pending.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "Native operation lock is unavailable.")?;
        ensure_not_quitting(&quit_pending)?;
        let config = load_config_at(&path)?.ok_or("No checkout is configured.")?;
        let backup_root = path
            .parent()
            .ok_or("Configuration path has no parent.")?
            .to_path_buf();
        update_inner(&config, &backup_root)
    })
    .await
    .map_err(|e| format!("Update worker failed: {e}"))?
}

fn update_inner(config: &DesktopConfig, backup_root: &Path) -> Result<UpdateResult, String> {
    update_inner_with_health_timeout(config, backup_root, HEALTH_TIMEOUT)
}

fn update_inner_with_health_timeout(
    config: &DesktopConfig,
    backup_root: &Path,
    health_timeout: Duration,
) -> Result<UpdateResult, String> {
    let checked = check_update_inner(config)?;
    let from = checked
        .current
        .ok_or("Cannot determine current Git revision.")?;
    let target = checked.target.ok_or("Cannot determine origin/HEAD.")?;
    if !checked.available {
        return Ok(UpdateResult {
            updated: false,
            from,
            to: Some(target),
            backup_path: None,
            rolled_back: false,
            detail: checked
                .detail
                .unwrap_or_else(|| "No fast-forward update is available.".into()),
        });
    }
    let branch_ref = git(config, &["symbolic-ref", "--quiet", "HEAD"])?;
    if !branch_ref.starts_with("refs/heads/") {
        return Err("Updates require the adopted checkout to be on a local branch.".into());
    }
    ensure_clean_checkout(config, Some(&target))?;
    let mounts = configured_mounts(config)?;
    let backup_root = fs::canonicalize(backup_root)
        .map_err(|_| "Cannot resolve the private backup directory.".to_string())?;
    for mount in mounts.iter().filter(|m| m.kind == "bind") {
        if backup_root.starts_with(Path::new(&mount.source)) {
            return Err("The private update backup would be inside a project data directory; move the desktop configuration directory before updating.".into());
        }
    }
    let old_image = compose_image(config)?;
    if old_image.is_empty() {
        return Err(
            "Build the current checkout once before updating; no rollback image is available."
                .into(),
        );
    }
    let image_tag = format!("{}-odysseus", config.project);
    let backup_tag = format!("novum-xenium-rollback:{}-{}", config.project, timestamp());
    let tag = run_command(
        "docker",
        &[
            "image".into(),
            "tag".into(),
            old_image.clone(),
            backup_tag.clone(),
        ],
        None,
        Duration::from_secs(30),
    )?;
    command_ok(&tag, "Preserve current backend image")?;

    let backup_dir = backup_root.join(".novum-xenium-backups").join(format!(
        "{}-{}",
        config.project,
        timestamp()
    ));
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Cannot create rollback backup directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            backup_dir.parent().expect("backup parent"),
            fs::Permissions::from_mode(0o700),
        )
        .map_err(|e| format!("Cannot protect rollback backup directory: {e}"))?;
        fs::set_permissions(&backup_dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Cannot protect rollback backup directory: {e}"))?;
    }

    let stop = run_compose(
        config,
        &["stop", "--timeout", "30"],
        Duration::from_secs(60),
    )?;
    if let Err(error) = command_ok(&stop, "Stop backend before its snapshot") {
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(error);
    }
    if let Err(error) = snapshot_mounts(&old_image, &backup_dir, &mounts) {
        let _ = run_compose(config, &["start"], Duration::from_secs(120));
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(format!(
            "Could not snapshot all project data; the old backend was restarted: {error}"
        ));
    }
    if let Err(error) = write_manifest(
        &backup_dir,
        &from,
        &target,
        &old_image,
        &backup_tag,
        &mounts,
    ) {
        let _ = run_compose(config, &["start"], Duration::from_secs(120));
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(format!(
            "Could not finalize the rollback manifest; the old backend was restarted: {error}"
        ));
    }

    if let Err(error) = git_output(
        config,
        &["switch", "--detach", &target],
        Duration::from_secs(30),
    )
    .and_then(|output| command_ok(&output, "Switch to update"))
    {
        let _ = run_compose(config, &["start"], Duration::from_secs(120));
        return Err(format!(
            "Could not switch to the update; the old backend was restarted. Backup: {}. {error}",
            backup_dir.display()
        ));
    }
    let target_mounts = configured_mounts(config);
    if target_mounts.as_ref().map(|m| m != &mounts).unwrap_or(true) {
        let _ = switch_to_branch(config, &branch_ref);
        let _ = run_compose(config, &["start"], Duration::from_secs(120));
        return Err(format!("The update changes or invalidates persistent Compose mounts; no update was applied. Backup: {}.", backup_dir.display()));
    }
    let build = run_compose(config, &["build", "odysseus"], Duration::from_secs(1800));
    if let Err(error) = build.and_then(|output| command_ok(&output, "Build updated backend")) {
        let _ = restore_image_tag(&old_image, &image_tag);
        let _ = switch_to_branch(config, &branch_ref);
        let _ = run_compose(config, &["start"], Duration::from_secs(120));
        return Err(format!(
            "Update build failed; the existing backend was restarted. Backup: {}. {error}",
            backup_dir.display()
        ));
    }
    let up = run_compose(config, &["up", "-d"], Duration::from_secs(900));
    let started = up.and_then(|output| command_ok(&output, "Start updated backend"));
    let mut finalize_error = None;
    if started.is_ok() && probe_health_for(config, health_timeout) {
        let advance = git_output(
            config,
            &["update-ref", &branch_ref, &target, &from],
            Duration::from_secs(30),
        )
        .and_then(|output| command_ok(&output, "Advance checkout branch"));
        match advance {
            Ok(()) => match switch_to_branch(config, &branch_ref) {
                Ok(()) => {
                    return Ok(UpdateResult {
                        updated: true,
                        from,
                        to: Some(target),
                        backup_path: Some(backup_dir.to_string_lossy().into_owned()),
                        rolled_back: false,
                        detail: format!(
                            "Updated successfully. Previous version and project data are backed up at {}.",
                            backup_dir.display()
                        ),
                    });
                }
                Err(error) => finalize_error = Some(error),
            },
            Err(error) => finalize_error = Some(error),
        }
    }

    let update_error = started
        .err()
        .or(finalize_error)
        .unwrap_or_else(|| "Updated backend failed its local health check.".into());
    let _ = run_compose(
        config,
        &["stop", "--timeout", "20"],
        Duration::from_secs(45),
    );
    let restore = restore_mounts(&old_image, &backup_dir, &mounts);
    let switch_back = restore_branch(config, &branch_ref, &from, &target);
    let restore_image = restore_image_tag(&old_image, &image_tag);
    if restore.is_err() || switch_back.is_err() || restore_image.is_err() {
        return Err(format!("{update_error} Automatic rollback could not restore every component; project data backup: {}.", backup_dir.display()));
    }
    let rollback_start = run_compose(
        config,
        &["up", "-d", "--force-recreate"],
        Duration::from_secs(900),
    )
    .and_then(|output| command_ok(&output, "Restart previous backend"));
    if rollback_start.is_ok() && probe_health_for(config, health_timeout) {
        return Ok(UpdateResult {
            updated: false,
            from,
            to: Some(target),
            backup_path: Some(backup_dir.to_string_lossy().into_owned()),
            rolled_back: true,
            detail: format!("{update_error} Previous source and data were restored and the old backend is healthy. Backup: {}.", backup_dir.display()),
        });
    }
    Err(format!("{update_error} Automatic rollback restored the source/data but could not confirm old backend health. Backup: {}.", backup_dir.display()))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct MountBackup {
    kind: String,
    source: String,
    archive: String,
}

fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn compose_image(config: &DesktopConfig) -> Result<String, String> {
    let output = run_compose(
        config,
        &["images", "-q", "odysseus"],
        Duration::from_secs(30),
    )?;
    command_ok(&output, "Inspect current backend image")?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn switch_to_branch(config: &DesktopConfig, branch_ref: &str) -> Result<(), String> {
    let branch = branch_ref
        .strip_prefix("refs/heads/")
        .ok_or("Cannot safely switch to a non-local checkout branch.")?;
    let output = git_output(config, &["switch", branch], Duration::from_secs(30))?;
    command_ok(&output, "Return to checkout branch")
}

fn restore_branch(
    config: &DesktopConfig,
    branch_ref: &str,
    from: &str,
    target: &str,
) -> Result<(), String> {
    let detached = git_output(
        config,
        &["switch", "--detach", from],
        Duration::from_secs(30),
    )?;
    command_ok(&detached, "Restore previous source revision")?;
    let current = git(config, &["rev-parse", branch_ref])?;
    if current == target {
        let reset_ref = git_output(
            config,
            &["update-ref", branch_ref, from, target],
            Duration::from_secs(30),
        )?;
        command_ok(&reset_ref, "Restore checkout branch pointer")?;
    } else if current != from {
        return Err("Checkout branch moved during update; refusing to overwrite it.".into());
    }
    switch_to_branch(config, branch_ref)
}

fn restore_image_tag(old_image: &str, tag: &str) -> Result<(), String> {
    let output = run_command(
        "docker",
        &["image".into(), "tag".into(), old_image.into(), tag.into()],
        None,
        Duration::from_secs(30),
    )?;
    command_ok(&output, "Restore previous backend image")
}

fn ensure_clean_checkout(config: &DesktopConfig, target: Option<&str>) -> Result<(), String> {
    let output = git_output(
        config,
        &["status", "--porcelain=v1", "-uall"],
        Duration::from_secs(20),
    )?;
    command_ok(&output, "Check checkout state")?;
    if output.truncated {
        return Err(
            "Checkout status exceeded the safe inspection limit; refusing to update.".into(),
        );
    }
    let status = String::from_utf8_lossy(&output.stdout);
    for line in status.lines() {
        let path = line.get(3..).unwrap_or_default();
        if line.starts_with("?? ") && matches!(path, "docker.local.yml" | "docker.host-local.yml") {
            if let Some(target) = target {
                let present = run_command(
                    "git",
                    &["cat-file".into(), "-e".into(), format!("{target}:{path}")],
                    Some(Path::new(&config.checkout)),
                    Duration::from_secs(15),
                )?;
                if present.code == Some(0) {
                    return Err(format!(
                        "The update adds {path}, which conflicts with your local overlay."
                    ));
                }
            }
            continue;
        }
        return Err("The checkout has local changes. Commit or move them before updating.".into());
    }
    Ok(())
}

fn configured_mounts(config: &DesktopConfig) -> Result<Vec<MountBackup>, String> {
    let output = run_compose(
        config,
        &["config", "--format", "json"],
        Duration::from_secs(30),
    )?;
    command_ok(&output, "Inspect Compose data mounts")?;
    let document: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        "Compose returned an unreadable mount configuration; refusing to update.".to_string()
    })?;
    parse_mounts(&document, config)
}

fn parse_mounts(
    document: &serde_json::Value,
    config: &DesktopConfig,
) -> Result<Vec<MountBackup>, String> {
    let allowed_bind_targets = [
        "/app/data",
        "/workspace",
        "/app/logs",
        "/app/.ssh",
        "/app/.cache/huggingface",
        "/app/.local",
        "/app/static",
        "/root/.ollama",
    ];
    let checkout_file_mounts = [
        (
            "/tmp/searxng-settings.yml.template",
            "config/searxng/settings.yml",
        ),
        (
            "/tmp/searxng-settings.yml.template",
            "config/searxng/settings.local.yml",
        ),
        (
            "/tmp/migrate-searxng-settings.py",
            "scripts/migrate_searxng_settings.py",
        ),
    ];
    let allowed_volume_targets = ["/chroma/chroma", "/data", "/etc/searxng", "/var/cache/ntfy"];
    let mut mounts = Vec::new();
    let mut sources = Vec::<PathBuf>::new();
    let mut volumes = Vec::<String>::new();
    let services = document
        .get("services")
        .and_then(|v| v.as_object())
        .ok_or("Compose has no services object.")?;
    let declared_volumes = document.get("volumes").and_then(|v| v.as_object());
    for service in services.values() {
        for volume in service
            .get("volumes")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let kind = volume
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let target = volume
                .get("target")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let source = volume
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if kind == "bind" {
                if checkout_file_mounts
                    .iter()
                    .any(|(expected_target, _)| *expected_target == target)
                {
                    if volume.get("read_only").and_then(|v| v.as_bool()) != Some(true) {
                        return Err(format!(
                            "Compose checkout file mount {target} must be read-only."
                        ));
                    }
                    let checkout = fs::canonicalize(&config.checkout)
                        .map_err(|_| "Checkout path is unavailable.".to_string())?;
                    let path = fs::canonicalize(source).map_err(|_| {
                        format!("Compose checkout file for {target} is unavailable.")
                    })?;
                    let expected = checkout_file_mounts
                        .iter()
                        .filter(|(expected_target, _)| *expected_target == target)
                        .filter_map(|(_, relative)| fs::canonicalize(checkout.join(relative)).ok())
                        .any(|expected| expected == path);
                    if !expected || !path.is_file() {
                        return Err(format!(
                            "Compose checkout file mount {target} must use the versioned checkout file."
                        ));
                    }
                    mounts.push(MountBackup {
                        kind: "checkout-file".into(),
                        source: path.to_string_lossy().into_owned(),
                        archive: String::new(),
                    });
                    continue;
                }
                let checkout = fs::canonicalize(&config.checkout)
                    .map_err(|_| "Checkout path is unavailable.".to_string())?;
                let canonical_source = fs::canonicalize(source).ok();
                if let Some(path) = canonical_source.filter(|path| path.starts_with(&checkout)) {
                    if let Ok(relative) = path.strip_prefix(&checkout) {
                        if let Some(relative_text) = relative.to_str() {
                            let first = relative
                                .components()
                                .next()
                                .and_then(|part| part.as_os_str().to_str());
                            let is_overlay_source = relative == Path::new("app.py")
                                || matches!(first, Some("static" | "src" | "routes" | "core"));
                            if is_overlay_source {
                                let expected_target =
                                    format!("/app/{}", relative_text.replace('\\', "/"));
                                if target != expected_target
                                    || volume.get("read_only").and_then(|v| v.as_bool())
                                        != Some(true)
                                    || !(path.is_file() || path.is_dir())
                                {
                                    return Err(format!(
                                        "Checkout source mount {target} must be read-only at {expected_target}."
                                    ));
                                }
                                mounts.push(MountBackup {
                                    kind: if path.is_dir() {
                                        "checkout"
                                    } else {
                                        "checkout-file"
                                    }
                                    .into(),
                                    source: path.to_string_lossy().into_owned(),
                                    archive: String::new(),
                                });
                                continue;
                            }
                        }
                    }
                }
                if !allowed_bind_targets.contains(&target)
                    || source.starts_with("/dev/")
                    || source.starts_with("/proc/")
                    || source.starts_with("/sys/")
                    || source.contains("docker.sock")
                {
                    return Err(format!("Compose bind mount {target} is outside the supported rollback-safe layout."));
                }
                let path = fs::canonicalize(source).map_err(|_| {
                    format!("Compose data path {target} does not exist or is not accessible.")
                })?;
                let protected = [
                    "/", "/etc", "/dev", "/proc", "/sys", "/run", "/var", "/usr", "/bin", "/opt",
                    "/home",
                ];
                if !path.is_dir()
                    || path.to_string_lossy().contains(',')
                    || protected.iter().any(|p| path == Path::new(p))
                {
                    return Err(format!(
                        "Compose data path {target} cannot be safely snapshotted."
                    ));
                }
                if target == "/app/static" {
                    let checkout = fs::canonicalize(&config.checkout)
                        .map_err(|_| "Checkout path is unavailable.".to_string())?;
                    if !path.starts_with(&checkout) {
                        return Err(
                            "The /app/static mount must point inside the selected checkout.".into(),
                        );
                    }
                    mounts.push(MountBackup {
                        kind: "checkout".into(),
                        source: path.to_string_lossy().into_owned(),
                        archive: String::new(),
                    });
                } else {
                    sources.push(path);
                }
            } else if kind == "volume" {
                if !allowed_volume_targets.contains(&target) || source.is_empty() {
                    return Err(format!("Compose named volume {target} is outside the supported rollback-safe layout."));
                }
                let declaration = declared_volumes.and_then(|vols| vols.get(source));
                let resolved = declaration
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        if declaration
                            .and_then(|v| v.get("external"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                        {
                            source.to_string()
                        } else {
                            format!("{}-{source}", config.project)
                        }
                    });
                if resolved.contains(',') {
                    return Err("A Compose volume name cannot be safely snapshotted.".into());
                }
                volumes.push(resolved);
            } else {
                return Err(format!(
                    "Compose mount type {kind} is not supported for safe updates."
                ));
            }
        }
    }
    sources.sort_by_key(|p| p.components().count());
    sources.dedup();
    let mut roots = Vec::<PathBuf>::new();
    for source in sources {
        if !roots.iter().any(|root| source.starts_with(root)) {
            roots.push(source);
        }
    }
    for (i, source) in roots.iter().enumerate() {
        mounts.push(MountBackup {
            kind: "bind".into(),
            source: source.to_string_lossy().into_owned(),
            archive: format!("bind-{i}.tar.gz"),
        });
    }
    volumes.sort();
    volumes.dedup();
    for (i, source) in volumes.iter().enumerate() {
        mounts.push(MountBackup {
            kind: "volume".into(),
            source: source.clone(),
            archive: format!("volume-{i}.tar.gz"),
        });
    }
    mounts.sort_by(|a, b| (&a.kind, &a.source, &a.archive).cmp(&(&b.kind, &b.source, &b.archive)));
    if mounts.is_empty() {
        return Err("Compose defines no persistent project data to back up.".into());
    }
    Ok(mounts)
}

fn snapshot_mounts(image: &str, backup_dir: &Path, mounts: &[MountBackup]) -> Result<(), String> {
    for mount in mounts {
        if mount.kind == "bind" || mount.kind == "volume" {
            helper_tar(image, backup_dir, mount, false)?;
        }
    }
    Ok(())
}

fn restore_mounts(image: &str, backup_dir: &Path, mounts: &[MountBackup]) -> Result<(), String> {
    for mount in mounts {
        if mount.kind == "bind" || mount.kind == "volume" {
            helper_tar(image, backup_dir, mount, true)?;
        }
    }
    Ok(())
}

fn helper_tar(
    image: &str,
    backup_dir: &Path,
    mount: &MountBackup,
    restore: bool,
) -> Result<(), String> {
    let mut args = vec![
        "run".into(),
        "--rm".into(),
        "--network".into(),
        "none".into(),
        "--user".into(),
        "0:0".into(),
        "--entrypoint".into(),
        "sh".into(),
    ];
    let read_only = if restore { "" } else { ",readonly" };
    if mount.kind == "bind" {
        args.extend([
            "--mount".into(),
            format!("type=bind,src={},dst=/source{read_only}", mount.source),
        ]);
    } else {
        args.extend([
            "--mount".into(),
            format!("type=volume,src={},dst=/source{read_only}", mount.source),
        ]);
    }
    args.extend([
        "--mount".into(),
        format!("type=bind,src={},dst=/backup", backup_dir.display()),
    ]);
    args.extend([image.into(), "-c".into()]);
    let archive = format!("/backup/{}", mount.archive);
    let script = if restore {
        format!("for p in /source/* /source/.[!.]* /source/..?*; do [ -e \"$p\" ] || [ -L \"$p\" ] || continue; rm -rf -- \"$p\" || exit; done; tar -xzf '{}' -C /source", archive)
    } else {
        format!("tar -czf '{}' -C /source .", archive)
    };
    args.push(script);
    let output = run_command("docker", &args, None, Duration::from_secs(1800))?;
    command_ok(
        &output,
        if restore {
            "Restore project data"
        } else {
            "Snapshot project data"
        },
    )
}

fn write_manifest(
    backup_dir: &Path,
    from: &str,
    target: &str,
    image: &str,
    image_tag: &str,
    mounts: &[MountBackup],
) -> Result<(), String> {
    let manifest = serde_json::json!({
        "from": from,
        "target": target,
        "image": image,
        "imageTag": image_tag,
        "createdAtMs": timestamp(),
        "mounts": mounts,
    });
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(backup_dir.join("manifest.json"), bytes)
        .map_err(|e| format!("Cannot write rollback manifest: {e}"))
}

fn app_startup() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_manager(app);
        }))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("manager-navigation")
                .on_navigation(|webview, url| {
                    if webview.label() != "main" {
                        return true;
                    }
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                        || (url.scheme() == "https" && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("localhost")
                            && url.port() == Some(1420))
                })
                .build(),
        )
        .manage(NativeState::default())
        .setup(|app| {
            match install_tray(&app.handle()) {
                Ok(tray) => {
                    let state = app.state::<NativeState>();
                    let host_available = tray_host_available();
                    state.tray_created.store(true, Ordering::Release);
                    *state.tray_icon.lock().expect("tray lock poisoned") = Some(tray);
                    if !host_available {
                        eprintln!(
                            "No StatusNotifierWatcher is available; using no-tray close behavior"
                        );
                    }
                }
                Err(error) => {
                    eprintln!("System tray unavailable; using no-tray close behavior: {error}")
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if !matches!(window.label(), "main" | "workbench") {
                return;
            }
            if window.label() == "workbench" && matches!(event, WindowEvent::Resized(_)) {
                if let Some(webview) = window.app_handle().get_webview_window("workbench") {
                    update_workbench_chrome(&webview);
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<NativeState>() {
                    if state.quit_pending.load(Ordering::Acquire) {
                        api.prevent_close();
                        show_quit_pending_notice(&app);
                    } else {
                        let tray_created = state.tray_created.load(Ordering::Acquire);
                        let host_available = tray_created && tray_host_available();
                        let operation_busy = state.operation.try_lock().is_err();
                        if can_hide_to_tray(tray_created, host_available) {
                            api.prevent_close();
                            if let Err(error) = window.hide() {
                                eprintln!("Cannot hide window to tray: {error}");
                            }
                        } else if operation_busy {
                            api.prevent_close();
                            if window.label() == "main"
                                && app.get_webview_window("workbench").is_none()
                            {
                                quit_when_idle(&app);
                            } else {
                                show_manager(&app);
                            }
                        } else if window.label() == "main" {
                            if let Some(workbench) = app.get_webview_window("workbench") {
                                api.prevent_close();
                                if workbench.show().is_ok() {
                                    let _ = workbench.set_focus();
                                    if let Err(error) = window.hide() {
                                        eprintln!(
                                            "Cannot hide manager while workspace is open: {error}"
                                        );
                                        show_manager(&app);
                                    }
                                } else {
                                    show_manager(&app);
                                }
                            }
                        } else if window.label() == "workbench" {
                            if app
                                .get_webview_window("main")
                                .is_some_and(|manager| !manager.is_visible().unwrap_or(true))
                            {
                                if !show_manager(&app) {
                                    api.prevent_close();
                                }
                            }
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            save_config,
            start_backend,
            stop_backend,
            read_logs,
            open_workbench,
            check_update,
            update_backend
        ])
}

pub fn run() {
    app_startup()
        .run(tauri::generate_context!())
        .expect("failed to run Novum Xenium desktop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn workbench_notification_accepts_only_bounded_title_and_body() {
        let url = tauri::Url::parse("nx-workbench://notify?title=Ready&body=Done%20now").unwrap();
        assert_eq!(
            workbench_notification(&url),
            Some(WorkbenchNotification {
                title: "Ready".into(),
                body: "Done now".into(),
            })
        );
        let long_title = format!("nx-workbench://notify?title={}&body=x", "a".repeat(121));
        let long_body = format!("nx-workbench://notify?title=x&body={}", "a".repeat(501));
        assert!(workbench_notification(&tauri::Url::parse(&long_title).unwrap()).is_none());
        assert!(workbench_notification(&tauri::Url::parse(&long_body).unwrap()).is_none());
    }

    #[test]
    fn workbench_notification_rejects_malformed_routes_and_parameters() {
        for raw in [
            "nx-workbench://notify?title=x", // missing body
            "nx-workbench://notify?title=x&body=y&extra=z",
            "nx-workbench://notify?title=x&title=y&body=z",
            "nx-workbench://notify?title=x&body=y&",
            "nx-workbench://notify/path?title=x&body=y",
            "nx-workbench://notify:80?title=x&body=y",
            "nx-workbench://user@notify?title=x&body=y",
            "nx-workbench://notify?title=x&body=y#fragment",
            "nx-workbench://ready?title=x&body=y",
            "nx-workbench://notify?title=%20%20&body=y",
        ] {
            let url = tauri::Url::parse(raw).unwrap();
            assert!(workbench_notification(&url).is_none(), "accepted {raw}");
        }
    }

    #[test]
    fn external_browser_accepts_only_web_urls_without_credentials() {
        for url in [
            "http://127.0.0.1:7000/static/image.png",
            "https://example.org/image.png?name=hello%20world",
        ] {
            assert!(browser_url_allowed(&url.parse().unwrap()));
        }
        for url in [
            "blob:http://127.0.0.1:7000/id",
            "data:image/png;base64,AA==",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "nx-workbench://close",
            "https://user:secret@example.org/",
        ] {
            assert!(!browser_url_allowed(&url.parse().unwrap()));
        }
    }

    #[test]
    fn download_suggestions_are_portable_basenames() {
        assert_eq!(safe_download_name(Path::new("/tmp/image.png")), "image.png");
        assert_eq!(safe_download_name(Path::new("../photo?.png")), "photo_.png");
        assert_eq!(
            safe_download_name(Path::new("evil\\image\n.png")),
            "evil_image_.png"
        );
        for name in ["...", "NUL", "CON.txt", "COM1.png", "LPT9", " . "] {
            assert_eq!(safe_download_name(Path::new(name)), "download");
        }
        assert!(safe_download_name(Path::new(&"🐾".repeat(200))).len() <= 180);
    }

    #[test]
    fn blob_downloads_require_the_selected_backend_origin() {
        assert!(workbench_blob_allowed(
            &"blob:http://127.0.0.1:7000/id".parse().unwrap(),
            7000
        ));
        for url in [
            "blob:https://evil.org/id",
            "blob:http://127.0.0.1:7001/id",
            "blob:file:///etc/image",
            "data:image/png;base64,AA==",
            "blob:null/id",
        ] {
            assert!(!workbench_blob_allowed(&url.parse().unwrap(), 7000));
        }
    }

    #[test]
    fn workspace_window_controls_are_narrow_and_origin_pinned() {
        for action in [
            "ready",
            "drag",
            "minimize",
            "toggle-maximize",
            "close",
            "native-frame",
        ] {
            let url = format!("nx-workbench://{action}").parse().unwrap();
            assert_eq!(workbench_window_action(&url), Some(action));
        }
        for url in [
            "nx-workbench://start_backend",
            "nx-workbench://close/other",
            "nx-workbench://close?command=stop_backend",
            "nx-workbench://close#other",
            "nx-workbench://user@close",
            "http://close",
            "nx-workbench://close:7000",
        ] {
            assert_eq!(workbench_window_action(&url.parse().unwrap()), None);
        }
        for url in [
            "http://127.0.0.1:7000/",
            "http://localhost:7000/login",
            "http://[::1]:7000/",
        ] {
            assert!(workbench_origin_allowed(&url.parse().unwrap(), 7000));
        }
        for url in [
            "http://localhost:7001/",
            "http://localhost.evil:7000/",
            "https://evil:7000/",
            "file:///tmp/page",
            "http://user:pass@localhost:7000/",
        ] {
            assert!(!workbench_origin_allowed(&url.parse().unwrap(), 7000));
        }
        assert!(workbench_control_origin_allowed(
            &"http://127.0.0.1:7000/".parse().unwrap(),
            7000
        ));
        for url in [
            "http://localhost:7000/",
            "https://127.0.0.1:7000/",
            "http://127.0.0.1:7001/",
        ] {
            assert!(!workbench_control_origin_allowed(
                &url.parse().unwrap(),
                7000
            ));
        }
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("docker-compose.yml"), "services: {}\n").unwrap();
        dir
    }

    #[test]
    fn close_to_tray_requires_created_icon_and_linux_watcher() {
        assert!(!can_hide_to_tray(false, true));
        assert!(!can_hide_to_tray(true, false));
        assert!(can_hide_to_tray(true, true));
    }

    #[test]
    fn queued_quit_rejects_new_native_operations() {
        let pending = AtomicBool::new(false);
        assert!(ensure_not_quitting(&pending).is_ok());
        pending.store(true, Ordering::Release);
        assert!(ensure_not_quitting(&pending).is_err());
    }

    #[test]
    fn tray_host_probe_detects_empty_session_bus_when_requested() {
        if std::env::var_os("NOVUM_TEST_EMPTY_TRAY_BUS").is_some() {
            assert!(!tray_host_available());
            assert!(!can_hide_to_tray(true, tray_host_available()));
        }
    }

    #[test]
    fn config_requires_compose_and_valid_project() {
        let dir = fixture();
        let valid = DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7010,
            project: String::new(),
        };
        let saved = validate_config(valid).unwrap();
        assert_eq!(saved.project, DEFAULT_PROJECT);
        assert_eq!(saved.port, 7010);
        assert!(validate_config(DesktopConfig {
            project: "BAD NAME".into(),
            ..saved
        })
        .is_err());
    }

    #[test]
    fn compose_arguments_are_scoped_and_optional_files_are_allowlisted() {
        let dir = fixture();
        fs::write(dir.path().join("docker.local.yml"), "services: {}\n").unwrap();
        fs::write(dir.path().join("attacker.yml"), "services: {}\n").unwrap();
        let config = validate_config(DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7000,
            project: "odysseus-local".into(),
        })
        .unwrap();
        let (_, args) = compose_args(&config, &["ps"]);
        assert_eq!(
            args,
            [
                "compose",
                "-p",
                "odysseus-local",
                "-f",
                "docker-compose.yml",
                "-f",
                "docker.local.yml",
                "ps"
            ]
        );
        assert!(!args.iter().any(|arg| arg == "attacker.yml"));
    }

    #[test]
    fn output_capture_keeps_a_bounded_tail() {
        let (bytes, truncated) = capture_tail(&b"0123456789"[..], 4);
        assert_eq!(bytes, b"6789");
        assert!(truncated);
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_kills_only_its_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("orphan-ran");
        let script = format!("(sleep 0.6; touch '{}') & wait", marker.display());
        let start = Instant::now();
        let result = run_command(
            "sh",
            &["-c".into(), script],
            None,
            Duration::from_millis(100),
        );
        assert!(result.unwrap_err().contains("time limit"));
        thread::sleep(Duration::from_millis(700));
        assert!(
            !marker.exists(),
            "timeout must stop the owned child process group"
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn command_rejects_child_left_holding_output_pipe() {
        let start = Instant::now();
        let result = run_command(
            "sh",
            &["-c".into(), "sleep 10 & exit 0".into()],
            None,
            Duration::from_secs(5),
        );
        assert!(result.unwrap_err().contains("output-producing child"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn saved_config_is_atomic_and_round_trips() {
        let dir = fixture();
        let path = dir.path().join("settings/config.json");
        let config = DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7001,
            project: "safe-project".into(),
        };
        save_config_at(&path, config.clone()).unwrap();
        assert_eq!(
            load_config_at(&path).unwrap(),
            Some(validate_config(config).unwrap())
        );
    }

    #[test]
    fn update_mount_inventory_deduplicates_nested_binds_and_records_named_volumes() {
        let dir = fixture();
        let data = dir.path().join("data");
        let workspace = data.join("agent_workspace/workspace");
        let logs = dir.path().join("logs");
        let static_files = dir.path().join("static");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&static_files).unwrap();
        let config = DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7000,
            project: "odysseus-local".into(),
        };
        let spec = serde_json::json!({
            "services": {
                "odysseus": { "volumes": [
                    {"type":"bind", "source":data, "target":"/app/data"},
                    {"type":"bind", "source":workspace, "target":"/workspace"},
                    {"type":"bind", "source":logs, "target":"/app/logs"},
                    {"type":"bind", "source":static_files, "target":"/app/static", "read_only":true}
                ]},
                "chromadb": { "volumes": [
                    {"type":"volume", "source":"chromadb-data", "target":"/data"}
                ]}
            },
            "volumes": {"chromadb-data":{"name":"odysseus-local-chromadb-data"}}
        });
        let mounts = parse_mounts(&spec, &config).unwrap();
        assert_eq!(
            mounts.len(),
            4,
            "nested workspace belongs in its parent data snapshot"
        );
        assert!(mounts.iter().any(|m| m.kind == "checkout"));
        assert!(mounts
            .iter()
            .any(|m| m.source.ends_with("odysseus-local-chromadb-data")));
    }

    #[test]
    fn update_mount_inventory_accepts_readonly_checkout_overlays_and_local_runtime_data() {
        let dir = fixture();
        let mut mounts = Vec::new();
        for (relative, target) in [
            ("app.py", "/app/app.py"),
            ("src/agent_loop.py", "/app/src/agent_loop.py"),
            ("routes/chat_routes.py", "/app/routes/chat_routes.py"),
            ("core/session_manager.py", "/app/core/session_manager.py"),
            ("static/js/chat.js", "/app/static/js/chat.js"),
            (
                "config/searxng/settings.local.yml",
                "/tmp/searxng-settings.yml.template",
            ),
            (
                "scripts/migrate_searxng_settings.py",
                "/tmp/migrate-searxng-settings.py",
            ),
        ] {
            let path = dir.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "fixture\n").unwrap();
            mounts.push(serde_json::json!({
                "type":"bind", "source":path, "target":target, "read_only":true
            }));
        }
        let ollama = dir.path().join("data/ollama");
        fs::create_dir_all(&ollama).unwrap();
        mounts.push(serde_json::json!({
            "type":"bind", "source":ollama, "target":"/root/.ollama"
        }));
        let config = DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7000,
            project: DEFAULT_PROJECT.into(),
        };
        let spec = serde_json::json!({
            "services": {
                "odysseus": {"volumes": mounts},
                "chromadb": {"volumes": [
                    {"type":"volume", "source":"chroma", "target":"/data"}
                ]},
                "ntfy": {"volumes": [
                    {"type":"volume", "source":"ntfy", "target":"/var/cache/ntfy"}
                ]},
                "searxng": {"volumes": [
                    {"type":"volume", "source":"searx", "target":"/etc/searxng"}
                ]}
            },
            "volumes": {
                "chroma":{"name":"odysseus-local_chromadb-data"},
                "ntfy":{"name":"odysseus-local_ntfy-cache"},
                "searx":{"name":"odysseus-local_searxng-data"}
            }
        });
        let inventory = parse_mounts(&spec, &config).unwrap();
        assert_eq!(
            inventory
                .iter()
                .filter(|m| m.kind == "checkout-file")
                .count(),
            7
        );
        assert!(inventory.iter().any(|m| m.kind == "bind"
            && Path::new(&m.source).ends_with(Path::new("data").join("ollama"))));
        assert!(inventory
            .iter()
            .any(|m| m.kind == "volume" && m.source.ends_with("chromadb-data")));
    }

    #[test]
    fn update_preflight_rejects_unrecognized_bind_mounts() {
        let dir = fixture();
        let config = DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7000,
            project: "odysseus-local".into(),
        };
        let spec = serde_json::json!({
            "services": {"odysseus": {"volumes": [
                {"type":"bind", "source":dir.path(), "target":"/host/docker.sock"}
            ]}}
        });
        let error = parse_mounts(&spec, &config).unwrap_err();
        assert!(error.contains("outside the supported"));
    }

    #[test]
    fn default_read_only_searxng_checkout_files_are_not_backed_up_as_data() {
        let dir = fixture();
        let settings = dir.path().join("config/searxng/settings.yml");
        let migration = dir.path().join("scripts/migrate_searxng_settings.py");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::create_dir_all(migration.parent().unwrap()).unwrap();
        fs::write(&settings, "use_default_settings: true\n").unwrap();
        fs::write(&migration, "print('migration')\n").unwrap();
        let config = DesktopConfig {
            checkout: dir.path().to_string_lossy().into_owned(),
            port: 7000,
            project: DEFAULT_PROJECT.into(),
        };
        let spec = serde_json::json!({
            "services": {"searxng": {"volumes": [
                {"type":"bind", "source":settings, "target":"/tmp/searxng-settings.yml.template", "read_only":true},
                {"type":"bind", "source":migration, "target":"/tmp/migrate-searxng-settings.py", "read_only":true}
            ]}}
        });
        let mounts = parse_mounts(&spec, &config).unwrap();
        assert_eq!(mounts.len(), 2);
        assert!(mounts.iter().all(|mount| mount.kind == "checkout-file"));
        assert!(mounts.iter().all(|mount| mount.archive.is_empty()));
        snapshot_mounts("unused-image", dir.path(), &mounts).unwrap();
        restore_mounts("unused-image", dir.path(), &mounts).unwrap();

        let writable = serde_json::json!({
            "services": {"searxng": {"volumes": [
                {"type":"bind", "source":settings, "target":"/tmp/searxng-settings.yml.template"}
            ]}}
        });
        assert!(parse_mounts(&writable, &config)
            .unwrap_err()
            .contains("must be read-only"));
    }

    #[test]
    fn health_identity_requires_selected_compose_service_and_loopback_port() {
        assert!(running_services_include_odysseus("chromadb\nodysseus\n"));
        assert!(!running_services_include_odysseus("chromadb\nsearxng\n"));
        assert!(loopback_port_matches("127.0.0.1:7010\n", 7010));
        assert!(loopback_port_matches("[::1]:7010\n", 7010));
        assert!(!loopback_port_matches("0.0.0.0:7010\n", 7010));
        assert!(!loopback_port_matches("127.0.0.1:7000\n", 7010));
        assert!(host_network_command_matches(
            "host",
            &[
                "uvicorn".into(),
                "app:app".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "7010".into(),
            ],
            7010,
        ));
        assert!(!host_network_command_matches(
            "host",
            &[
                "uvicorn".into(),
                "app:app".into(),
                "--host".into(),
                "0.0.0.0".into(),
                "--port".into(),
                "7010".into(),
            ],
            7010,
        ));
        assert!(!host_network_command_matches(
            "host",
            &[
                "uvicorn".into(),
                "app:app".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "7000".into(),
            ],
            7010,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn command_output_capture_is_bounded() {
        let output = run_command(
            "sh",
            &["-c".into(), "head -c 200000 /dev/zero".into()],
            None,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(output.stdout.len(), COMMAND_OUTPUT_LIMIT);
        assert!(output.truncated);
    }
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod update_tests;
