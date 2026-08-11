fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_serial_ports",
            "connect_transport",
            "scan_transport",
            "disconnect_transport",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
