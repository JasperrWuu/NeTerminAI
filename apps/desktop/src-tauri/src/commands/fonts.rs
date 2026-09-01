use super::run_blocking;

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    run_blocking("读取系统字体", || {
        #[cfg(windows)]
        {
            windows_fonts::list()
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::new())
        }
    })
    .await
}

#[cfg(windows)]
mod windows_fonts {
    use std::collections::BTreeMap;

    use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RegCloseKey, RegEnumValueW,
        RegOpenKeyExW,
    };
    use windows::core::{PWSTR, w};

    const FONT_KEY: windows::core::PCWSTR =
        w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts");

    pub fn list() -> Result<Vec<String>, String> {
        let mut families = BTreeMap::<String, String>::new();
        collect_from_root(HKEY_CURRENT_USER, &mut families)?;
        collect_from_root(HKEY_LOCAL_MACHINE, &mut families)?;
        Ok(families.into_values().collect())
    }

    fn collect_from_root(
        root: HKEY,
        families: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        let mut key = HKEY::default();
        let status = unsafe { RegOpenKeyExW(root, FONT_KEY, Some(0), KEY_READ, &mut key) };
        if status != ERROR_SUCCESS {
            return Ok(());
        }

        let result = enumerate_values(key, families);
        unsafe {
            let _ = RegCloseKey(key);
        }
        result
    }

    fn enumerate_values(key: HKEY, families: &mut BTreeMap<String, String>) -> Result<(), String> {
        let mut index = 0;
        loop {
            let mut name = [0u16; 512];
            let mut name_length = name.len() as u32;
            let status = unsafe {
                RegEnumValueW(
                    key,
                    index,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut name_length,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                return Ok(());
            }
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "读取 Windows 字体注册表失败（错误码 {}）",
                    status.0
                ));
            }

            let value_name = String::from_utf16_lossy(&name[..name_length as usize]);
            let family_name = value_name
                .split_once(" (")
                .map(|(family, _)| family)
                .unwrap_or(value_name.as_str());
            for family in family_name
                .split('&')
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                families
                    .entry(family.to_lowercase())
                    .or_insert_with(|| family.to_string());
            }
            index += 1;
        }
    }
}
