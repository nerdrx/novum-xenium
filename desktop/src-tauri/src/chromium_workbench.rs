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
    candidates.into_iter().find(|path| path.is_file())
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
        command.arg("--ozone-platform=wayland");
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::trusted_workbench_url;

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
