use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

const BRIDGE_SCRIPT: &str = include_str!("alarm_bridge.py");
const SERVICE_NAME: &str = "novum-alarm-bridge.service";
const CONTAINER_TARGET: &str = "/app/.local";
const HF_CACHE_TARGET: &str = "/app/.cache/huggingface";
static PROVISION_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Cannot create private local directory: {e}"))?;
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect private local directory: {e}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != libc_uid() {
        return Err("Local directory is not a private directory owned by this user.".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Cannot protect private local directory: {e}"))
}

#[cfg(unix)]
fn libc_uid() -> u32 {
    unsafe { getuid() }
}

#[cfg(unix)]
unsafe extern "C" {
    fn getuid() -> u32;
}

pub(super) fn atomic_private_write(path: &Path, contents: &[u8]) -> Result<bool, String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() || !meta.is_file() || meta.uid() != libc_uid() {
            return Err("Refusing to replace an unsafe private local file.".into());
        }
        if fs::read(path).map_err(|e| format!("Cannot read private local file: {e}"))? == contents {
            return Ok(false);
        }
    }
    let parent = path
        .parent()
        .ok_or("Private local file has no parent directory.")?;
    let temp = parent.join(format!(".alarm-install-{}", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| format!("Cannot prepare private local file: {e}"))?;
    let result = (|| {
        file.write_all(contents)
            .map_err(|e| format!("Cannot write private local file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Cannot save private local file: {e}"))?;
        fs::rename(&temp, path).map_err(|e| format!("Cannot install private local file: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map(|()| true)
}

pub(super) fn systemd_quote(value: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("A local service path contains unsupported characters.".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('%', "%%").replace('$', "$$").replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn unit_contents(checkout: &Path, script: &Path, state_dir: &Path) -> Result<String, String> {
    let checkout = checkout
        .to_str()
        .ok_or("Configured checkout path is not valid UTF-8.")?;
    if checkout.chars().any(char::is_control) {
        return Err("Configured checkout path contains unsupported characters.".into());
    }
    let script = systemd_quote(
        script
            .to_str()
            .ok_or("Alarm script path is not valid UTF-8.")?,
    )?;
    let token = systemd_quote(
        state_dir
            .join("bridge-token")
            .to_str()
            .ok_or("Alarm token path is not valid UTF-8.")?,
    )?;
    let state = systemd_quote(
        state_dir
            .to_str()
            .ok_or("Alarm state path is not valid UTF-8.")?,
    )?;
    Ok(format!(
        "[Unit]\nDescription=Novum Xenium local alarm bridge\n# Novum-Checkout: {checkout}\n\n[Service]\nType=simple\nUMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=2s\nExecStart=/usr/bin/python3 {script} --token-file {token} --state-dir {state}\n\n[Install]\nWantedBy=default.target\n"
    ))
}

fn active_container_bind_source(config: &super::DesktopConfig, target: &str) -> Option<PathBuf> {
    let (checkout, args) = super::compose_args(config, &["ps", "-q", "odysseus"]);
    let output = super::run_command_env(
        "docker",
        &args,
        Some(&checkout),
        Duration::from_secs(8),
        &[
            ("APP_PORT", config.port.to_string()),
            ("APP_BIND", "127.0.0.1".into()),
        ],
    )
    .ok()?;
    if output.code != Some(0) || output.truncated {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if id.len() < 12 || id.len() > 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let inspect = super::run_command(
        "docker",
        &[
            "inspect".into(),
            "--format".into(),
            "{{json .Mounts}}".into(),
            id,
        ],
        None,
        Duration::from_secs(8),
    )
    .ok()?;
    if inspect.code != Some(0) || inspect.truncated {
        return None;
    }
    source_for_target(&String::from_utf8_lossy(&inspect.stdout), target)
}

pub(super) fn source_for_target(json: &str, target: &str) -> Option<PathBuf> {
    let mounts: Value = serde_json::from_str(json).ok()?;
    mounts.as_array()?.iter().find_map(|mount| {
        (mount.get("Type")?.as_str()? == "bind" && mount.get("Destination")?.as_str()? == target)
            .then(|| mount.get("Source")?.as_str().map(PathBuf::from))?
    })
}

fn compose_config_bind_source(config: &super::DesktopConfig, target: &str) -> Option<PathBuf> {
    let (checkout, args) = super::compose_args(config, &["config", "--format", "json"]);
    let output = super::run_command_env(
        "docker",
        &args,
        Some(&checkout),
        Duration::from_secs(12),
        &[
            ("APP_PORT", config.port.to_string()),
            ("APP_BIND", "127.0.0.1".into()),
        ],
    )
    .ok()?;
    if output.code != Some(0) || output.truncated {
        return None;
    }
    compose_source_for_target(&String::from_utf8_lossy(&output.stdout), target)
}

fn compose_source_for_target(json: &str, target: &str) -> Option<PathBuf> {
    let config: Value = serde_json::from_str(json).ok()?;
    config
        .get("services")?
        .get("odysseus")?
        .get("volumes")?
        .as_array()?
        .iter()
        .find_map(|volume| {
            (volume.get("target")?.as_str()? == target
                && volume.get("type")?.as_str()? == "bind")
                .then(|| volume.get("source")?.as_str().map(PathBuf::from))?
        })
}

fn fallback_data_dir(checkout: &Path) -> PathBuf {
    let from_env = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            fs::read_to_string(checkout.join(".env"))
                .ok()
                .and_then(|contents| {
                    contents.lines().find_map(|line| {
                        let (key, value) = line.split_once('=')?;
                        if key.trim() != "APP_DATA_DIR" {
                            return None;
                        }
                        let value = value.trim();
                        let value = value
                            .strip_prefix('"')
                            .and_then(|v| v.strip_suffix('"'))
                            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                            .unwrap_or(value);
                        (!value.is_empty() && !value.contains("${")).then(|| PathBuf::from(value))
                    })
                })
        });
    let data = from_env.unwrap_or_else(|| PathBuf::from("data"));
    let data = if data.is_absolute() {
        data
    } else {
        checkout.join(data)
    };
    data
}

fn local_mount_source(config: &super::DesktopConfig) -> Result<PathBuf, String> {
    let checkout = PathBuf::from(&config.checkout);
    let source = active_container_bind_source(config, CONTAINER_TARGET)
        .or_else(|| compose_config_bind_source(config, CONTAINER_TARGET))
        .unwrap_or_else(|| fallback_data_dir(&checkout).join("local"));
    if !source.is_absolute() {
        return Err(
            "The configured container local-data mount did not resolve to an absolute host path."
                .into(),
        );
    }
    Ok(source)
}

pub(super) fn hf_cache_source(config: &super::DesktopConfig) -> Result<PathBuf, String> {
    let source = active_container_bind_source(config, HF_CACHE_TARGET)
        .or_else(|| compose_config_bind_source(config, HF_CACHE_TARGET))
        .ok_or("The backend has no verified shared Hugging Face cache bind mount.")?;
    if !source.is_absolute() {
        return Err("The configured model-cache mount did not resolve to an absolute host path.".into());
    }
    let source = fs::canonicalize(source)
        .map_err(|_| "The shared Hugging Face cache directory is unavailable.".to_string())?;
    if !source.is_dir() {
        return Err("The shared Hugging Face cache is not a directory.".into());
    }
    Ok(source)
}

pub(super) fn run_systemctl(args: &[&str]) -> Result<(), String> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).into()).collect();
    let result =
        super::run_command("systemctl", &args, None, Duration::from_secs(8)).map_err(|_| {
            "The user systemd manager is unavailable for local service setup.".to_string()
        })?;
    if result.code == Some(0) {
        Ok(())
    } else {
        Err(
            "Could not install or start the local service with the user systemd manager."
                .into(),
        )
    }
}

pub(super) fn provision_owned_service(
    checkout: &Path,
    script_path: &Path,
    script_contents: &str,
    systemd_user_dir: &Path,
    service_name: &str,
    contents: &str,
) -> Result<(), String> {
    let checkout = fs::canonicalize(checkout)
        .map_err(|_| "The configured checkout is unavailable for service setup.".to_string())?;
    if checkout.to_string_lossy().chars().any(char::is_control) {
        return Err("Configured checkout path contains unsupported characters.".into());
    }
    if !service_name.ends_with(".service")
        || !service_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("The local service name is invalid.".into());
    }
    let _guard = PROVISION_LOCK
        .lock()
        .map_err(|_| "Local service setup is unavailable.".to_string())?;
    run_systemctl(&["--user", "show-environment"])?;
    ensure_private_dir(script_path.parent().ok_or("Local script path has no parent directory.")?)?;
    let unit_path = systemd_user_dir.join(service_name);
    let existing = match fs::symlink_metadata(&unit_path) {
        Ok(meta)
            if meta.file_type().is_symlink() || !meta.is_file() || meta.uid() != libc_uid() =>
        {
            return Err("Refusing to replace an unsafe local service file.".into());
        }
        Ok(_) => Some(
            fs::read_to_string(&unit_path)
                .map_err(|_| "Cannot read the existing local service file.".to_string())?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Cannot inspect the existing local service file.".into()),
    };
    if let Some(existing) = &existing {
        let marker = format!("# Novum-Checkout: {}", checkout.display());
        if !existing.lines().any(|line| line == marker) {
            return Err("The local model-sync service belongs to another checkout; it was left unchanged.".into());
        }
    }
    let script_changed = atomic_private_write(script_path, script_contents.as_bytes())?;
    ensure_private_dir(systemd_user_dir)?;
    let unit_changed = atomic_private_write(&unit_path, contents.as_bytes())?;
    if unit_changed {
        run_systemctl(&["--user", "daemon-reload"])?;
    }
    run_systemctl(&["--user", "enable", "--now", service_name])?;
    if (script_changed || unit_changed) && existing.is_some() {
        run_systemctl(&["--user", "restart", service_name])?;
    }
    Ok(())
}

pub(crate) fn provision(
    config: &super::DesktopConfig,
    app_data_dir: &Path,
    systemd_user_dir: &Path,
) -> Result<(), String> {
    let _guard = PROVISION_LOCK
        .lock()
        .map_err(|_| "Local alarm setup is unavailable.".to_string())?;
    if !Path::new("/usr/bin/python3").is_file() {
        return Err("Python 3 is required for local alarm delivery on Linux.".into());
    }
    run_systemctl(&["--user", "show-environment"])?;

    let checkout = fs::canonicalize(&config.checkout)
        .map_err(|_| "The configured local checkout is unavailable for alarm setup.".to_string())?;
    let source = local_mount_source(config)?;
    ensure_private_dir(&source.join("novum-alarms"))?;
    let state_dir = source.join("novum-alarms");

    let script_dir = app_data_dir.join("alarms").join("v1");
    ensure_private_dir(&script_dir)?;
    let script_path = script_dir.join("alarm_bridge.py");
    let unit_path = systemd_user_dir.join(SERVICE_NAME);
    let contents = unit_contents(&checkout, &script_path, &state_dir)?;

    let existing = match fs::symlink_metadata(&unit_path) {
        Ok(meta)
            if meta.file_type().is_symlink() || !meta.is_file() || meta.uid() != libc_uid() =>
        {
            return Err("Refusing to replace an unsafe local alarm service file.".into());
        }
        Ok(_) => Some(
            fs::read_to_string(&unit_path)
                .map_err(|_| "Cannot read the existing local alarm service file.".to_string())?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Cannot inspect the existing local alarm service file.".into()),
    };
    if let Some(existing) = &existing {
        let marker = format!("# Novum-Checkout: {}", checkout.display());
        if !existing.lines().any(|line| line == marker) {
            return Err("A Novum alarm service is already assigned to another checkout; it was left unchanged.".into());
        }
    }

    let script_changed = atomic_private_write(&script_path, BRIDGE_SCRIPT.as_bytes())?;
    ensure_private_dir(systemd_user_dir)?;
    let unit_changed = atomic_private_write(&unit_path, contents.as_bytes())?;
    if unit_changed {
        run_systemctl(&["--user", "daemon-reload"])?;
    }
    run_systemctl(&["--user", "enable", "--now", SERVICE_NAME])?;
    if (script_changed || unit_changed) && existing.is_some() {
        run_systemctl(&["--user", "restart", SERVICE_NAME])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn only_the_local_bind_mount_is_selected() {
        let mounts = r#"[{"Type":"bind","Source":"/srv/odysseus/data/local","Destination":"/app/.local"},{"Type":"bind","Source":"/srv/odysseus/data/huggingface","Destination":"/app/.cache/huggingface"},{"Type":"volume","Source":"x","Destination":"/app/data"}]"#;
        assert_eq!(
            source_for_target(mounts, CONTAINER_TARGET),
            Some(PathBuf::from("/srv/odysseus/data/local"))
        );
        assert_eq!(
            source_for_target(mounts, HF_CACHE_TARGET),
            Some(PathBuf::from("/srv/odysseus/data/huggingface"))
        );
        assert_eq!(source_for_target(mounts, "/app/data"), None);
        let compose = r#"{"services":{"odysseus":{"volumes":[{"type":"bind","source":"/srv/novum/data/huggingface","target":"/app/.cache/huggingface"},{"type":"volume","source":"hf-cache","target":"/other"}]}}}"#;
        assert_eq!(
            compose_source_for_target(compose, HF_CACHE_TARGET),
            Some(PathBuf::from("/srv/novum/data/huggingface"))
        );
        assert_eq!(compose_source_for_target(compose, "/other"), None);
    }

    #[test]
    fn fallback_uses_data_subdirectories_without_changing_the_mount_contract() {
        let checkout = Path::new("/srv/novum");
        assert_eq!(fallback_data_dir(checkout).join("local"), checkout.join("data/local"));
        assert_eq!(fallback_data_dir(checkout).join("huggingface"), checkout.join("data/huggingface"));
    }

    #[test]
    fn unit_has_stable_checkout_identity_and_private_process_defaults() {
        let unit = unit_contents(
            Path::new("/srv/novum"),
            Path::new("/home/test/.local/share/novum-xenium/alarms/v1/alarm_bridge.py"),
            Path::new("/srv/novum/data/local/novum-alarms"),
        )
        .unwrap();
        assert!(unit.contains("# Novum-Checkout: /srv/novum\n"));
        assert!(!unit.contains("After=default.target"));
        assert!(unit.contains("ExecStart=/usr/bin/python3 \"/home/test/.local/share/novum-xenium/alarms/v1/alarm_bridge.py\""));
        assert!(
            unit.contains("UMask=0077\nNoNewPrivileges=true\nRestart=on-failure\nRestartSec=2s\n")
        );
        assert!(unit.contains("/srv/novum/data/local/novum-alarms/bridge-token"));
    }

    #[test]
    fn installed_files_are_private_and_not_rewritten_when_identical() {
        let dir = tempdir().unwrap();
        ensure_private_dir(dir.path()).unwrap();
        let target = dir.path().join("unit.service");
        assert!(atomic_private_write(&target, b"unit").unwrap());
        assert!(!atomic_private_write(&target, b"unit").unwrap());
        assert_eq!(
            fs::symlink_metadata(target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
