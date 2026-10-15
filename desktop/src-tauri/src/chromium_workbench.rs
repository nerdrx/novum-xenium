use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn chromium_executable() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/opt/google/chrome/chrome"),
        PathBuf::from("/usr/bin/google-chrome-stable"),
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/chromium"),
        PathBuf::from("/usr/bin/chromium-browser"),
    ];
    candidates
        .into_iter()
        .find(|path| is_executable(path))
        .or_else(|| chromium_from_path(std::env::var_os("PATH")))
}

fn chromium_from_path(path: Option<std::ffi::OsString>) -> Option<PathBuf> {
    std::env::split_paths(path.as_ref()?).find_map(|directory| {
        [
            "google-chrome-stable",
            "google-chrome",
            "chromium",
            "chromium-browser",
        ]
        .into_iter()
        .map(|name| directory.join(name))
        .find(|candidate| is_executable(candidate))
    })
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    true
}

fn trusted_workbench_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid workbench URL.".to_string())?;
    if parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"))
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Chromium workbench must use the configured local service URL.".into());
    }
    Ok(())
}

pub fn command(url: &str, profile_dir: &Path) -> Result<Command, String> {
    trusted_workbench_url(url)?;
    let executable = chromium_executable()
        .ok_or("Google Chrome or Chromium was not found. Choose the embedded workbench instead.")?;
    fs::create_dir_all(profile_dir)
        .map_err(|error| format!("Cannot create Chromium profile directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(profile_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Cannot protect Chromium profile directory: {error}"))?;
    }

    let mut command = Command::new(executable);
    command
        .arg(format!("--app={url}"))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run");
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        // Use compositor callbacks instead of the timer-based Linux frame source.
        command
            .arg("--ozone-platform=wayland")
            .arg("--enable-features=WaylandExternalBeginFrameSource");
    }
    Ok(command)
}

/// Chromium app-mode derives its Wayland identity from the URL and profile.
/// A hidden desktop entry lets the compositor resolve the app's NX icon.
pub fn install_window_identity(url: &str, profile: &Path, data: &Path) -> Result<(), String> {
    trusted_workbench_url(url)?;
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Window identity requires the workbench root URL.".into());
    }
    let identity = format!("chrome-{}__-Default", parsed.host_str().unwrap());
    let applications = data.join("applications");
    fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
    let entry = applications.join(format!("{identity}.desktop"));
    const MARKER: &str = "X-Novum-Workbench=true";
    if entry.exists()
        && !fs::read_to_string(&entry)
            .map_err(|e| e.to_string())?
            .contains(MARKER)
    {
        // Do not replace another application's launcher for the same local URL.
        return Ok(());
    }
    let icon = profile.join("nx-icon.png");
    fs::write(&icon, include_bytes!("../icons/icon.png")).map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let quoted = executable
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    let icon_path = icon
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    fs::write(entry, format!("[Desktop Entry]\nType=Application\nName=Novum Xenium\nNoDisplay=true\nExec=\"{quoted}\"\nIcon={icon_path}\nStartupWMClass={identity}\n{MARKER}\n"))
        .map_err(|e| format!("Cannot register workbench icon: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{chromium_from_path, install_window_identity, trusted_workbench_url};

    #[test]
    fn finds_chromium_installed_on_path() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("chromium");
        std::fs::write(&executable, "stub").unwrap();
        let path = std::env::join_paths([root.path()]).unwrap();
        assert_eq!(chromium_from_path(Some(path.clone())), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(chromium_from_path(Some(path)), Some(executable));
        assert_eq!(chromium_from_path(None), None);
    }

    #[test]
    fn registers_icon_without_overwriting_foreign_launcher() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        install_window_identity("http://127.0.0.1:7000/", &profile, root.path()).unwrap();
        let entry = root
            .path()
            .join("applications/chrome-127.0.0.1__-Default.desktop");
        let text = std::fs::read_to_string(&entry).unwrap();
        assert!(text.contains("StartupWMClass=chrome-127.0.0.1__-Default"));
        assert!(profile.join("nx-icon.png").is_file());
        std::fs::write(&entry, "foreign launcher").unwrap();
        install_window_identity("http://127.0.0.1:7000/", &profile, root.path()).unwrap();
        assert_eq!(std::fs::read_to_string(entry).unwrap(), "foreign launcher");
    }

    #[test]
    fn accepts_only_local_http_workbench_urls() {
        assert!(trusted_workbench_url("http://127.0.0.1:7300/").is_ok());
        assert!(trusted_workbench_url("http://localhost:7300/").is_ok());
        for url in [
            "https://127.0.0.1:7300/",
            "http://127.0.0.1/",
            "http://127.0.0.1.evil:7300/",
            "http://user@127.0.0.1:7300/",
            "http://example.com:7300/",
        ] {
            assert!(trusted_workbench_url(url).is_err(), "accepted {url}");
        }
    }
}
