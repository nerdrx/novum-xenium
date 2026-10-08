use std::ffi::{c_char, c_void, CStr};
use webkit2gtk::{glib::translate::ToGlibPtr, WebViewExt};

// WebKit 2.42 added the feature API after our GTK bindings were generated.
// Resolve it at runtime so older supported installations still start normally.
pub fn prefer_display_refresh(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        let Some(settings) = webview.inner().settings() else {
            return;
        };
        // All pointers are owned by WebKit. The list owns its feature entries;
        // it remains alive until after the setting is changed, then is released.
        let result = unsafe {
            (|| -> Result<(), libloading::Error> {
                let library = libloading::os::unix::Library::this();
                let list = library.get::<unsafe extern "C" fn() -> *mut c_void>(
                    b"webkit_settings_get_all_features\0",
                )?;
                let length = library.get::<unsafe extern "C" fn(*mut c_void) -> usize>(
                    b"webkit_feature_list_get_length\0",
                )?;
                let get = library.get::<unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void>(
                    b"webkit_feature_list_get\0",
                )?;
                let identifier = library
                    .get::<unsafe extern "C" fn(*mut c_void) -> *const c_char>(
                        b"webkit_feature_get_identifier\0",
                    )?;
                let set = library.get::<unsafe extern "C" fn(
                    *mut webkit2gtk::ffi::WebKitSettings,
                    *mut c_void,
                    i32,
                )>(b"webkit_settings_set_feature_enabled\0")?;
                let enabled = library.get::<unsafe extern "C" fn(
                    *mut webkit2gtk::ffi::WebKitSettings,
                    *mut c_void,
                ) -> i32>(
                    b"webkit_settings_get_feature_enabled\0"
                )?;
                let unref = library
                    .get::<unsafe extern "C" fn(*mut c_void)>(b"webkit_feature_list_unref\0")?;
                let features = list();
                if features.is_null() {
                    return Ok(());
                }
                for index in 0..length(features) {
                    let feature = get(features, index);
                    if feature.is_null() {
                        continue;
                    }
                    let name = identifier(feature);
                    if !name.is_null()
                        && CStr::from_ptr(name).to_bytes() == b"PreferPageRenderingUpdatesNear60FPS"
                    {
                        set(settings.to_glib_none().0, feature, 0);
                        eprintln!(
                            "WebKit: near-60-FPS rendering preference enabled={}",
                            enabled(settings.to_glib_none().0, feature) != 0
                        );
                        break;
                    }
                }
                unref(features);
                Ok(())
            })()
        };
        if let Err(error) = result {
            eprintln!("WebKit refresh preference unavailable; retaining defaults: {error}");
        }
    });
}
