use arboard::Clipboard;
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Serialize;
use std::thread;
use std::time::Duration;

#[derive(Serialize, Clone, Copy)]
pub struct CursorPoint {
    pub x: i32,
    pub y: i32,
}

fn enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_cursor_position() -> Result<CursorPoint, String> {
    let enigo = enigo()?;
    let (x, y) = enigo
        .location()
        .map_err(|error| error.to_string())?;
    Ok(CursorPoint { x, y })
}

#[tauri::command]
pub fn move_cursor(x: i32, y: i32) -> Result<(), String> {
    let mut enigo = enigo()?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn click_at(x: i32, y: i32) -> Result<(), String> {
    let mut enigo = enigo()?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|error| error.to_string())?;
    thread::sleep(Duration::from_millis(80));
    enigo
        .button(Button::Left, Direction::Click)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn send_hotkey(action: String) -> Result<(), String> {
    let mut enigo = enigo()?;
    match action.as_str() {
        "ctrl+v" => chord(&mut enigo, Key::Control, Key::Unicode('v'))?,
        "ctrl+c" => chord(&mut enigo, Key::Control, Key::Unicode('c'))?,
        "ctrl+a" => chord(&mut enigo, Key::Control, Key::Unicode('a'))?,
        "enter" => enigo
            .key(Key::Return, Direction::Click)
            .map_err(|error| error.to_string())?,
        "escape" => enigo
            .key(Key::Escape, Direction::Click)
            .map_err(|error| error.to_string())?,
        other => return Err(format!("Unsupported hotkey: {other}")),
    }
    Ok(())
}

fn chord(enigo: &mut Enigo, modifier: Key, key: Key) -> Result<(), String> {
    enigo
        .key(modifier, Direction::Press)
        .map_err(|error| error.to_string())?;
    thread::sleep(Duration::from_millis(30));
    enigo
        .key(key, Direction::Click)
        .map_err(|error| error.to_string())?;
    thread::sleep(Duration::from_millis(30));
    enigo
        .key(modifier, Direction::Release)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_text(text)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.get_text().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn sleep_ms(ms: u64) -> Result<(), String> {
    thread::sleep(Duration::from_millis(ms));
    Ok(())
}
