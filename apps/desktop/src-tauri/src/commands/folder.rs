#[tauri::command]
pub async fn choose_ftp_root(window: tauri::Window) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        super::run_blocking("选择 FTP 共享目录", move || choose(owner)).await
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("当前平台请手动输入共享目录。".into())
    }
}
#[cfg(windows)]
fn choose(owner: isize) -> Result<Option<String>, String> {
    use windows::{
        Win32::{
            Foundation::HWND,
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize,
            },
            UI::Shell::{
                FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, FileOpenDialog,
                IFileOpenDialog, SIGDN_FILESYSPATH,
            },
        },
        core::w,
    };
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
    }
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _guard = ComGuard;
    (|| -> windows::core::Result<Option<String>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)?;
            dialog.SetTitle(w!("选择 FTP 共享目录"))?;
            if let Err(e) = dialog.Show(Some(HWND(owner as *mut _))) {
                if e.code().0 as u32 == 0x800704c7 {
                    return Ok(None);
                }
                return Err(e);
            }
            let path = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let result = path.to_string();
            CoTaskMemFree(Some(path.0.cast()));
            Ok(Some(result?))
        }
    })()
    .map_err(|e| e.to_string())
}
