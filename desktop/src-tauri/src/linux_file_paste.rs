use base64::{engine::general_purpose::STANDARD, Engine};
use gtk::{gdk, prelude::*};
use javascriptcore::ValueExt;
use std::{fs::File, io::Read};
use webkit2gtk::{gio, WebViewExt};

const MAX_BYTES: usize = 50 * 1024 * 1024;

fn read_files(uris: &[String]) -> Result<Vec<serde_json::Value>, String> {
    if uris.len() > 10 { return Err("Paste up to 10 files at a time".into()) }
    let mut files = Vec::new();
    let mut remaining = MAX_BYTES;
    for uri in uris {
        let url = tauri::Url::parse(uri).map_err(|_| "Invalid copied file address")?;
        let path = url
            .to_file_path()
            .map_err(|_| "Only local files can be attached")?;
        if !path.is_file() {
            return Err("Copy files rather than folders to attach them".into());
        }
        let file = File::open(&path).map_err(|_| "Could not read a copied file")?;
        let mut data = Vec::new();
        file.take(remaining as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "Could not read a copied file")?;
        if data.len() > remaining {
            return Err("Copied attachments exceed 50 MB; choose fewer or smaller files".into());
        }
        remaining -= data.len();
        let (content_type, _) = gio::content_type_guess(Some(&path), &data);
        let mime = gio::content_type_get_mime_type(&content_type)
            .unwrap_or_else(|| "application/octet-stream".into());
        files.push(serde_json::json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"type":mime.as_str(),"data":STANDARD.encode(data)}));
    }
    Ok(files)
}

pub fn install(
    window: &tauri::WebviewWindow,
    allowed_port: std::sync::Arc<std::sync::atomic::AtomicU16>,
) {
    let owner = window.clone();
    let _ = window.with_webview(move |webview| {
        webview.inner().connect_key_press_event(move |view, event| {
            let control = event.state().contains(gdk::ModifierType::CONTROL_MASK);
            let shift = event.state().contains(gdk::ModifierType::SHIFT_MASK);
            let paste = (control && !shift && matches!(event.keyval(), gdk::keys::constants::v | gdk::keys::constants::V))
                || (shift && !control && event.keyval() == gdk::keys::constants::Insert);
            let port = allowed_port.load(std::sync::atomic::Ordering::Acquire);
            if !paste || !owner.url().is_ok_and(|u| crate::workbench_control_origin_allowed(&u, port)) {
                return gtk::glib::Propagation::Proceed;
            }
            let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let uris: Vec<String> = clipboard.wait_for_uris().iter().map(ToString::to_string).collect();
            if uris.is_empty() { return gtk::glib::Propagation::Proceed }
            let view = view.clone();
            let fallback = view.clone();
            let owner = owner.clone();
            // Only a real native paste key reaches here. Pages cannot submit paths
            // or invoke a filesystem command; paths come from the OS clipboard.
            #[allow(deprecated)] // Preserve compatibility with WebKit runtimes before 2.40.
            view.run_javascript("document.activeElement?.id === 'message' && !document.activeElement.disabled && !document.activeElement.readOnly && typeof window.__nxReceiveClipboardFiles === 'function'",
                None::<&gio::Cancellable>, move |result| {
                let composer = result.ok().and_then(|r| r.js_value()).is_some_and(|v| v.to_boolean());
                if !composer { fallback.execute_editing_command("Paste"); return }
                std::thread::spawn(move || {
                    match read_files(&uris) {
                        Ok(files) if owner.url().is_ok_and(|u| crate::workbench_control_origin_allowed(&u, port)) => {
                            let payload = serde_json::to_string(&files).expect("clipboard files serialize");
                            let _ = owner.eval(&format!("window.__nxReceiveClipboardFiles?.({payload});"));
                        }
                        Err(error) => crate::workbench_notice(&owner, &error),
                        _ => {}
                    }
                });
            });
            gtk::glib::Propagation::Stop
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_files_preserve_bytes_and_reject_nonfiles() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("space ü.txt");
        std::fs::write(&path, b"exact clipboard contents").unwrap();
        let files = read_files(&[tauri::Url::from_file_path(&path).unwrap().to_string()]).unwrap();
        assert_eq!(files[0]["name"], "space ü.txt");
        assert_eq!(
            files[0]["data"],
            STANDARD.encode(b"exact clipboard contents")
        );
        for uri in [
            "https://example.com/file",
            "file://remote-host/file",
            "file:///missing-nx-clipboard-test",
        ] {
            assert!(read_files(&[uri.into()]).is_err());
        }
        assert!(read_files(&[tauri::Url::from_directory_path(dir.path())
            .unwrap()
            .to_string()])
        .is_err());
        let huge = dir.path().join("huge.bin");
        File::create(&huge)
            .unwrap()
            .set_len(MAX_BYTES as u64 + 1)
            .unwrap();
        assert!(read_files(&[tauri::Url::from_file_path(huge).unwrap().to_string()]).is_err());
    }
}
