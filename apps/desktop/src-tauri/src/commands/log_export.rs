/// The frontend never supplies a destination path: only the native save dialog can choose it.
#[tauri::command]
pub async fn save_automation_log(
    window: tauri::Window,
    default_name: String,
    content: String,
) -> Result<bool, String> {
    if content.len() > 4 * 1024 * 1024 || default_name.len() > 1024 {
        return Err("日志过大，无法保存".to_owned());
    }
    if default_name
        .chars()
        .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("日志文件名无效".to_owned());
    }
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        super::run_blocking("保存日志", move || {
            save_native(owner, &default_name, &content)
        })
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = (window, default_name, content);
        Err("当前平台尚不支持日志保存对话框".to_owned())
    }
}

#[cfg(windows)]
fn save_native(owner: isize, default_name: &str, content: &str) -> Result<bool, String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
    use windows::{
        Win32::{
            Foundation::HWND,
            UI::Controls::Dialogs::{
                CommDlgExtendedError, GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR,
                OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
            },
        },
        core::{PCWSTR, PWSTR, w},
    };
    let mut filename = vec![0u16; 32768];
    let initial: Vec<u16> = default_name.encode_utf16().collect();
    filename[..initial.len()].copy_from_slice(&initial);
    let filters: Vec<u16> = "日志文件 (*.log)\0*.log\0文本文件 (*.txt)\0*.txt\0\0"
        .encode_utf16()
        .collect();
    let mut dialog = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: HWND(owner as *mut _),
        lpstrFilter: PCWSTR(filters.as_ptr()),
        nFilterIndex: 1,
        lpstrFile: PWSTR(filename.as_mut_ptr()),
        nMaxFile: filename.len() as u32,
        lpstrTitle: w!("保存终端自动化日志"),
        lpstrDefExt: w!("log"),
        Flags: OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST,
        ..Default::default()
    };
    // Buffers and UTF-16 strings remain alive for the entire modal native call.
    if !unsafe { GetSaveFileNameW(&mut dialog) }.as_bool() {
        let code = unsafe { CommDlgExtendedError() }.0;
        return if code == 0 {
            Ok(false)
        } else {
            Err(format!("无法打开保存对话框：{code}"))
        };
    }
    let end = filename
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(filename.len());
    let path = PathBuf::from(OsString::from_wide(&filename[..end]));
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !extension.eq_ignore_ascii_case("log") && !extension.eq_ignore_ascii_case("txt") {
        return Err("请选择 .log 或 .txt 文件名".to_owned());
    }
    write_log_file(&path, content)?;
    Ok(true)
}

#[cfg(any(windows, test))]
fn write_log_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content.as_bytes()).map_err(|error| format!("保存日志失败：{error}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn log_file_preserves_utf8_and_multiline_text() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "neterminai-log-export-{}-{stamp}.log",
            std::process::id()
        ));
        let content =
            "2026-09-08 10:21:03  INFO    设备:\n                             CPU: 10%\n\n完成\n";
        super::write_log_file(&path, content).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(bytes, content.as_bytes());
    }
}
