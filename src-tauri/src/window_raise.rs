use tauri::{AppHandle, Manager, UserAttentionType, WebviewWindow};

/// Force Daylight's main window above other apps (not just a modal inside an already-open window).
#[tauri::command]
pub fn force_raise_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;

    raise_window(&window);
    Ok(())
}

pub fn raise_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    // Stay above other apps long enough to answer the check-in.
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));

    #[cfg(windows)]
    raise_windows_foreground(window);

    #[cfg(target_os = "macos")]
    raise_macos_foreground(window);

    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(20));
        let _ = win.set_always_on_top(false);
    });
}

#[cfg(windows)]
fn raise_windows_foreground(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentThreadId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
        SW_SHOW,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0);

    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = ShowWindow(hwnd, SW_SHOW);

        let foreground = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(foreground, None);
        let cur_thread = GetCurrentThreadId();

        // Classic Windows focus-steal workaround when another app is active.
        if fg_thread != 0 && fg_thread != cur_thread {
            let _ = AttachThreadInput(cur_thread, fg_thread, true);
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(cur_thread, fg_thread, false);
        } else {
            let _ = BringWindowToTop(hwnd);
            let _ = SetForegroundWindow(hwnd);
        }

        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
}

#[cfg(target_os = "macos")]
fn raise_macos_foreground(window: &WebviewWindow) {
    // set_focus + always_on_top already applied; request attention again for dock bounce.
    let _ = window.set_focus();
    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
}
