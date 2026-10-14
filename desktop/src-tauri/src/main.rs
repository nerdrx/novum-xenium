#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Match the desktop launcher identity used by NX Hub on Wayland.
    #[cfg(target_os = "linux")]
    gtk::glib::set_prgname(Some("novum-xenium"));
    novum_xenium_desktop_lib::run();
}
