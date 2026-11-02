//! Dedicated CClip shell. No legacy telemetry, updater, proxy or processing bootstrap.
// The capability matches the loopback origin (Windows IPC strips the path).
// Navigation below restricts this window to this backend's active port.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

fn startup_note(data: &std::path::Path, message: &str) {
    use std::io::Write;
    if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(data.join("startup.log")) {
        let _ = writeln!(log, "{message}");
    }
}

const CLOSE_SCRIPT: &str = "if(window.__cclipCloseReady){window.dispatchEvent(new Event('cclip-close-request'))}else{window.location.href='cclip-close://approved'}";

struct LocalBackend {
    process: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    #[cfg(windows)]
    job: Mutex<Option<crate::windows_job::BackendJob>>,
}

impl LocalBackend {
    fn stop(&self) {
        if let Ok(mut port) = self.port.lock() { *port = None; }
        #[cfg(windows)]
        if let Ok(mut job) = self.job.lock() {
            job.take();
        }
        if let Ok(mut current) = self.process.lock() {
            if let Some(mut process) = current.take() {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(process.id() as i32), libc::SIGTERM);
                    for _ in 0..50 {
                        if matches!(process.try_wait(), Ok(Some(_))) { break; }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    libc::kill(-(process.id() as i32), libc::SIGKILL);
                }
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

fn resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().resource_dir().map_err(|_| "resources_unavailable")?;
    let candidates = [base.join("resources"), base.clone()];
    candidates.into_iter().find(|path| path.join("backend/workbench").is_dir())
        .ok_or_else(|| "bundled_backend_missing".to_string())
}

#[cfg(windows)]
fn focus_existing() {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut std::ffi::c_void;
        fn ShowWindow(window: *mut std::ffi::c_void, command: i32) -> i32;
        fn SetForegroundWindow(window: *mut std::ffi::c_void) -> i32;
    }
    let title: Vec<u16> = "CClip · 视频创作\0".encode_utf16().collect();
    unsafe {
        let window = FindWindowW(std::ptr::null(), title.as_ptr());
        if !window.is_null() { ShowWindow(window, 9); SetForegroundWindow(window); }
    }
}

fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if let Ok(mut current) = app.state::<LocalBackend>().process.lock() {
        if let Some(child) = current.as_mut() {
            if matches!(child.try_wait(), Ok(None)) { return Ok(()); }
        }
    }
    let root = resources(app)?;
    #[cfg(windows)]
    let python = root.join("python/python.exe");
    #[cfg(not(windows))]
    let python = root.join("python/bin/python3");
    if !python.is_file() {
        return Err("bundled_python_missing".into());
    }
    let data = std::env::var_os("CCLIP_TEST_DATA_DIR").map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok()).ok_or("data_directory_unavailable")?;
    std::fs::create_dir_all(&data).map_err(|_| "data_directory_unavailable")?;
    startup_note(&data, "backend_starting");
    let mut command = Command::new(python);
    command.env_clear();
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "SSL_CERT_FILE"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    command.args(["-m", "backend.workbench", "--full-app", "--port", "0", "--data-dir"])
        .arg(&data).arg("--frontend").arg(root.join("frontend"))
        .current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("PYTHONUTF8", "1").env("PYTHONDONTWRITEBYTECODE", "1")
        .env("AUTOCLIP_PARENT_PID", std::process::id().to_string())
        .env("CCLIP_BUNDLED_RESOURCES", &root)
        .env("AUTOCLIP_FFMPEG_PATH", root.join("ffmpeg").join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }))
        .env("AUTOCLIP_FFPROBE_PATH", root.join("ffmpeg").join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }));
    for name in ["SENTRY_DSN", "VITE_PUBLIC_SENTRY_DSN", "VITE_PUBLIC_POSTHOG_KEY", "DASHSCOPE_API_KEY", "OPENAI_API_KEY", "API_DASHSCOPE_API_KEY"] {
        command.env_remove(name);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| "backend_start_failed")?;
    let child_id = child.id();
    #[cfg(windows)]
    let job = match crate::windows_job::BackendJob::attach(&child) {
        Ok(job) => job,
        Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("backend_lifecycle_failed".into()); }
    };
    let output = child.stdout.take().ok_or("backend_output_missing")?;
    let error_output = child.stderr.take();
    // Drain stderr; runtime logs never become external telemetry or browser messages.
    if let Some(stderr) = error_output {
        std::thread::spawn(move || { for _line in BufReader::new(stderr).lines() {} });
    }
    *app.state::<LocalBackend>().process.lock().map_err(|_| "backend_lock_failed")? = Some(child);
    #[cfg(windows)]
    { *app.state::<LocalBackend>().job.lock().map_err(|_| "backend_lock_failed")? = Some(job); }
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if line == "WORKBENCH_ALREADY_RUNNING" {
                #[cfg(windows)]
                focus_existing();
                handle.exit(0);
                return;
            }
            if let Some(port) = line.strip_prefix("WORKBENCH_PORT=").and_then(|text| text.parse::<u16>().ok()) {
                if !is_current(&handle, child_id) { return; }
                if let Ok(mut active) = handle.state::<LocalBackend>().port.lock() { *active = Some(port); }
                startup_note(&data, "backend_port_received");
                let url = format!("http://127.0.0.1:{port}/cclip.html");
                // The child emits its port only after the listener and lifespan are ready.
                // Avoid an additional async-runtime handshake before creating the first window.
                startup_note(&data, "backend_ready");
                if let Ok(address) = url.parse() {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.navigate(address);
                        let _ = window.show();
                        let _ = window.set_focus();
                        return;
                    }
                    let exit_handle = handle.clone();
                    let result = tauri::WebviewWindowBuilder::new(&handle, "main", tauri::WebviewUrl::External(address))
                        .disable_drag_drop_handler()
                        .title("CClip · 视频创作").inner_size(1280.0, 800.0).min_inner_size(1100.0, 700.0)
                        .on_navigation(move |url| {
                            if url.scheme() == "cclip-close" && url.host_str() == Some("approved") {
                                exit_handle.exit(0);
                                return false;
                            }
                            if url.scheme() == "cclip-service" {
                                let action = url.host_str().unwrap_or("");
                                if matches!(action, "stop" | "restart") { exit_handle.state::<LocalBackend>().stop(); }
                                if matches!(action, "start" | "restart") { let _ = start(&exit_handle); }
                                return false;
                            }
                            let active = exit_handle.state::<LocalBackend>().port.lock().ok().and_then(|current| *current);
                            (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == active)
                                || active.is_some_and(|current| url.as_str().starts_with(&format!("blob:http://127.0.0.1:{current}/")))
                        })
                        .data_directory(data.join("webview")).center().build();
                    match result {
                        Ok(window) => {
                            let closing = window.clone();
                            window.on_window_event(move |event| {
                                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                                    api.prevent_close();
                                    let _ = closing.eval(CLOSE_SCRIPT);
                                }
                            });
                            startup_note(&data, "window_ready");
                        }
                        Err(error) => { startup_note(&data, &format!("window_failed: {error}")); handle.exit(1); }
                    }
                    return;
                }
                handle.exit(1);
                return;
            }
        }
        if is_current(&handle, child_id) { handle.exit(1); }
    });
    Ok(())
}

fn is_current(app: &tauri::AppHandle, pid: u32) -> bool {
    app.state::<LocalBackend>().process.lock().ok()
        .and_then(|current| current.as_ref().map(|child| child.id() == pid)).unwrap_or(false)
}

struct CClipTrayLabels([tauri::menu::MenuItem<tauri::Wry>; 6]);

fn tray_labels(language: &str) -> [&'static str; 6] {
    match language {
        "zh" => ["显示主窗口", "隐藏主窗口", "启动本机服务", "停止本机服务", "重启本机服务", "退出 CClip"],
        "ja" => ["ウィンドウを表示", "ウィンドウを隠す", "サービスを開始", "サービスを停止", "サービスを再起動", "CClip を終了"],
        "ko" => ["창 표시", "창 숨기기", "서비스 시작", "서비스 중지", "서비스 다시 시작", "CClip 종료"],
        "es" => ["Mostrar ventana", "Ocultar ventana", "Iniciar servicio", "Detener servicio", "Reiniciar servicio", "Salir de CClip"],
        "pt" => ["Mostrar janela", "Ocultar janela", "Iniciar serviço", "Parar serviço", "Reiniciar serviço", "Sair do CClip"],
        "ru" => ["Показать окно", "Скрыть окно", "Запустить службу", "Остановить службу", "Перезапустить службу", "Выйти из CClip"],
        "fr" => ["Afficher la fenêtre", "Masquer la fenêtre", "Démarrer le service", "Arrêter le service", "Redémarrer le service", "Quitter CClip"],
        _ => ["Show window", "Hide window", "Start local service", "Stop local service", "Restart local service", "Quit CClip"],
    }
}

#[tauri::command]
fn set_tray_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    let state = app.state::<CClipTrayLabels>();
    for (item, label) in state.0.iter().zip(tray_labels(&language)) { item.set_text(label).map_err(|e| e.to_string())?; }
    Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{menu::{MenuBuilder, MenuItem}, tray::TrayIconBuilder};
    let ids = ["show", "hide", "start", "stop", "restart", "quit"];
    let labels = tray_labels("zh");
    let items = [
        MenuItem::with_id(app, ids[0], labels[0], true, None::<&str>)?,
        MenuItem::with_id(app, ids[1], labels[1], true, None::<&str>)?,
        MenuItem::with_id(app, ids[2], labels[2], true, None::<&str>)?,
        MenuItem::with_id(app, ids[3], labels[3], true, None::<&str>)?,
        MenuItem::with_id(app, ids[4], labels[4], true, None::<&str>)?,
        MenuItem::with_id(app, ids[5], labels[5], true, None::<&str>)?,
    ];
    let menu = MenuBuilder::new(app).items(&[&items[0], &items[1], &items[2], &items[3], &items[4], &items[5]]).build()?;
    let mut tray = TrayIconBuilder::with_id("cclip").menu(&menu).tooltip("CClip");
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.on_menu_event(|app, event| {
        if let Some(window) = app.get_webview_window("main") {
            match event.id.as_ref() {
                "show" => { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
                "hide" => { let _ = window.hide(); }
                "quit" => { let _ = window.eval(CLOSE_SCRIPT); }
                action @ ("start" | "stop" | "restart") => {
                    let _ = window.eval(&format!("window.dispatchEvent(new CustomEvent('cclip-service-request',{{detail:'{action}'}}))"));
                }
                _ => {}
            }
        } else if matches!(event.id.as_ref(), "show" | "start" | "restart") { let _ = start(app); }
    }).build(app)?;
    app.manage(CClipTrayLabels(items));
    Ok(())
}

pub fn run() {
    // A fixed WebView2 needs these read/execute ACLs for its renderer on Windows
    // 10. Grant them on our own bundled directory, without an installer/admin.
    // The portable config makes Tauri select this runtime before creating windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(folder) = std::env::current_exe().ok().and_then(|path| path.parent().map(|p| p.join("resources/webview2"))) {
            if folder.join("msedgewebview2.exe").is_file() {
                let status = Command::new("icacls.exe").arg(folder)
                    .args(["/grant", "*S-1-15-2-2:(OI)(CI)(RX)", "*S-1-15-2-1:(OI)(CI)(RX)", "/q"])
                    .creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
                if !matches!(status, Ok(value) if value.success()) {
                    panic!("CClip could not prepare its bundled browser permissions");
                }
            }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![crate::commands::enable_autostart, crate::commands::disable_autostart,
            crate::commands::is_autostart_enabled, crate::commands::save_local_download, crate::commands::show_main_window,
            set_tray_language, crate::cclip_preferences::get_cclip_preferences, crate::cclip_preferences::set_cclip_preferences])
        .manage(LocalBackend { process: Mutex::new(None), port: Mutex::new(None), #[cfg(windows)] job: Mutex::new(None) })
        .setup(|app| {
            let data = std::env::var_os("CCLIP_TEST_DATA_DIR").map(PathBuf::from)
                .or_else(|| app.path().app_data_dir().ok()).ok_or_else(|| std::io::Error::other("data_directory_unavailable"))?;
            app.manage(crate::cclip_preferences::PreferenceStore::new(&data));
            setup_tray(app.handle())?;
            if let Err(error) = start(app.handle()) { return Err(std::io::Error::other(error).into()); }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CClip could not start")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { code: None, api, .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        api.prevent_exit();
                        let _ = window.eval(CLOSE_SCRIPT);
                    }
                }
                tauri::RunEvent::Exit => app.state::<LocalBackend>().stop(),
                _ => {}
            }
        });
}

#[cfg(test)]
mod capability_tests {
    use tauri::utils::acl::{capability::Capability, RemoteUrlPattern};

    #[test]
    fn accepts_windows_origin_and_page_url_with_hash_route() {
        let capability: Capability = serde_json::from_str(include_str!("../capabilities/cclip.json")).unwrap();
        assert_eq!(capability.windows, vec!["main"]);
        let remote = capability.remote.unwrap();
        for value in ["http://127.0.0.1:54121/", "http://127.0.0.1:54121/cclip.html#/settings"] {
            assert!(remote.urls.iter().any(|pattern| pattern.parse::<RemoteUrlPattern>().unwrap().test(&value.parse().unwrap())));
        }
        for value in ["https://example.com/", "http://192.168.1.2:54121/", "http://localhost:54121/"] {
            assert!(!remote.urls.iter().any(|pattern| pattern.parse::<RemoteUrlPattern>().unwrap().test(&value.parse().unwrap())));
        }
    }
}
