use std::{
    fs, io,
    path::{Path, PathBuf},
};

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub(super) fn resolve(
    root: &Path,
    cwd: &[String],
    input: &str,
    create: bool,
) -> io::Result<(PathBuf, Vec<String>)> {
    let denied = || {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Path outside shared root or unsupported link",
        )
    };
    if input.contains(['\\', ':', '\0', '\r', '\n']) {
        return Err(denied());
    }
    let mut parts = if input.starts_with('/') {
        Vec::new()
    } else {
        cwd.to_vec()
    };
    for part in input.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                if parts.pop().is_none() {
                    return Err(denied());
                }
            }
            _ => {
                let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                if part.to_ascii_lowercase().starts_with(".neterminai-upload-")
                    || part.ends_with([' ', '.'])
                    || matches!(
                        base.as_str(),
                        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                    )
                    || (base.len() == 4
                        && (base.starts_with("COM") || base.starts_with("LPT"))
                        && base.as_bytes()[3].is_ascii_digit())
                {
                    return Err(denied());
                }
                parts.push(part.into());
            }
        }
    }
    let mut path = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if linked(&meta) || !fs::canonicalize(&path)?.starts_with(root) {
                    return Err(denied());
                }
            }
            Err(e) if create && index + 1 == parts.len() && e.kind() == io::ErrorKind::NotFound => {
            }
            Err(e) => return Err(e),
        }
    }
    Ok((path, parts))
}
pub(super) fn listing(root: &Path, path: &Path, names_only: bool) -> io::Result<Vec<u8>> {
    let mut output = String::new();
    let paths: Box<dyn Iterator<Item = io::Result<PathBuf>>> = if path.is_dir() {
        Box::new(fs::read_dir(path)?.map(|e| e.map(|e| e.path())))
    } else {
        Box::new(std::iter::once(Ok(path.to_path_buf())))
    };
    for path in paths {
        let path = path?;
        let metadata = fs::symlink_metadata(&path)?;
        if linked(&metadata) || !fs::canonicalize(&path)?.starts_with(root) {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.to_ascii_lowercase().starts_with(".neterminai-upload-")
            || name.contains(['\r', '\n'])
        {
            continue;
        }
        if names_only {
            output.push_str(&format!("{name}\r\n"));
        } else {
            output.push_str(&format!(
                "{} 1 ftp ftp {} {} {name}\r\n",
                if metadata.is_dir() {
                    "drwxr-xr-x"
                } else {
                    "-rw-r--r--"
                },
                metadata.len(),
                modified_date(&metadata)?
            ));
        }
        if output.len() > 4 * 1024 * 1024 {
            return Err(io::Error::other("Directory listing too large"));
        }
    }
    Ok(output.into_bytes())
}

fn modified_date(metadata: &fs::Metadata) -> io::Result<String> {
    let seconds = match metadata.modified()?.duration_since(std::time::UNIX_EPOCH) {
        Ok(value) => value.as_secs() as i64,
        Err(value) => -(value.duration().as_secs() as i64),
    };
    // Gregorian civil date from UTC epoch days; LIST's year form avoids locale-dependent parsing.
    let z = seconds.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let day_of_era = z - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = month_index + if month_index < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let name = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][(month - 1) as usize];
    Ok(format!("{name} {day:02} {year}"))
}
