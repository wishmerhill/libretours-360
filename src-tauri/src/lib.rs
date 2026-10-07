/// WebView2 (unlike desktop Chrome) does not always ship a software WebGL
/// fallback: on machines without a usable GPU driver for ANGLE — VMs, remote
/// desktop sessions, or GPU disabled by policy, all common on Windows 11 —
/// WebGL context creation can fail without throwing, leaving Photo Sphere
/// Viewer's canvas permanently black instead of erroring visibly. Forcing
/// SwiftShader here gives WebGL a software path to fall back to.
/// Must be set before the WebView2 environment is created, i.e. before the
/// builder runs. Left untouched if the user already set it themselves.
#[cfg(target_os = "windows")]
fn configure_webview2_gpu_fallback() {
  if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
    std::env::set_var(
      "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
      "--disable-gpu-compositing --enable-unsafe-swiftshader --use-angle=swiftshader",
    );
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[cfg(target_os = "windows")]
  configure_webview2_gpu_fallback();

  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}