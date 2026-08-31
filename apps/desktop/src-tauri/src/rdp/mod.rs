use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl RdpBounds {
    pub fn physical(self, scale_factor: f64) -> PhysicalRdpBounds {
        PhysicalRdpBounds {
            x: (self.x * scale_factor).round() as i32,
            y: (self.y * scale_factor).round() as i32,
            width: (self.width * scale_factor).round().max(1.0) as i32,
            height: (self.height * scale_factor).round().max(1.0) as i32,
        }
    }
}

#[derive(Clone, Copy)]
pub struct PhysicalRdpBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Default)]
pub struct RdpManager {
    sessions: Arc<Mutex<HashMap<String, isize>>>,
}

impl RdpManager {
    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        parent: windows::Win32::Foundation::HWND,
        session_id: String,
        host: &str,
        port: u16,
        username: &str,
        admin_session: bool,
        bounds: PhysicalRdpBounds,
    ) -> Result<(), String> {
        windows_host::create(
            self,
            parent,
            session_id,
            host,
            port,
            username,
            admin_session,
            bounds,
        )
    }

    #[cfg(windows)]
    pub fn resize(
        &self,
        session_id: &str,
        bounds: PhysicalRdpBounds,
        visible: bool,
    ) -> Result<(), String> {
        windows_host::resize(self, session_id, bounds, visible)
    }

    #[cfg(windows)]
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        windows_host::close(self, session_id)
    }

    #[cfg(not(windows))]
    pub fn unsupported(&self) -> Result<(), String> {
        Err("应用内 RDP 当前仅支持 Windows".to_owned())
    }

    fn insert(&self, session_id: String, handle: isize) -> Result<Option<isize>, String> {
        self.sessions
            .lock()
            .map(|mut sessions| sessions.insert(session_id, handle))
            .map_err(|_| "RDP 会话状态不可用".to_owned())
    }

    fn get(&self, session_id: &str) -> Result<Option<isize>, String> {
        self.sessions
            .lock()
            .map(|sessions| sessions.get(session_id).copied())
            .map_err(|_| "RDP 会话状态不可用".to_owned())
    }

    fn remove(&self, session_id: &str) -> Result<Option<isize>, String> {
        self.sessions
            .lock()
            .map(|mut sessions| sessions.remove(session_id))
            .map_err(|_| "RDP 会话状态不可用".to_owned())
    }
}

#[cfg(windows)]
mod windows_host {
    use super::{PhysicalRdpBounds, RdpManager};
    use std::{cell::Cell, ffi::c_void};
    use windows::{
        Win32::{
            Foundation::HWND,
            System::{
                Com::{
                    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS,
                    IDispatch,
                },
                LibraryLoader::{GetProcAddress, LoadLibraryW},
                Ole::{DISPID_PROPERTYPUT, OleInitialize},
                Variant::VARIANT,
            },
            UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, HWND_TOP, SW_HIDE, SW_SHOW, SWP_NOACTIVATE,
                SWP_SHOWWINDOW, SetWindowPos, ShowWindow, WINDOW_EX_STYLE, WS_CHILD,
                WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
            },
        },
        core::{BOOL, GUID, HRESULT, IUnknown, Interface, PCWSTR, s, w},
    };

    type AtlAxWinInitFn = unsafe extern "system" fn() -> BOOL;
    type AtlAxGetControlFn = unsafe extern "system" fn(HWND, *mut *mut c_void) -> HRESULT;

    thread_local! {
        static OLE_READY: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) struct AtlApi {
        initialize: AtlAxWinInitFn,
        get_control: AtlAxGetControlFn,
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        manager: &RdpManager,
        parent: HWND,
        session_id: String,
        host: &str,
        port: u16,
        username: &str,
        admin_session: bool,
        bounds: PhysicalRdpBounds,
    ) -> Result<(), String> {
        validate_session_id(&session_id)?;
        validate_connection(host, port, username)?;
        ensure_ole_initialized()?;

        let window = unsafe {
            if !(atl_api()?.initialize)().as_bool() {
                return Err("Windows RDP 宿主初始化失败".to_owned());
            }
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("AtlAxWin"),
                w!("MsRdpClient10NotSafeForScripting"),
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                Some(parent),
                None,
                None,
                None,
            )
            .map_err(|error| format!("无法创建应用内 RDP 视图：{error}"))?
        };

        if let Err(error) = configure_control(window, host, port, username, admin_session, bounds) {
            unsafe {
                let _ = DestroyWindow(window);
            }
            return Err(error);
        }

        if let Some(previous) = manager.insert(session_id, window.0 as isize)? {
            destroy(HWND(previous as *mut c_void));
        }
        unsafe {
            SetWindowPos(
                window,
                Some(HWND_TOP),
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|error| format!("无法显示应用内 RDP 视图：{error}"))?;
        }
        Ok(())
    }

    pub fn resize(
        manager: &RdpManager,
        session_id: &str,
        bounds: PhysicalRdpBounds,
        visible: bool,
    ) -> Result<(), String> {
        let Some(handle) = manager.get(session_id)? else {
            return Ok(());
        };
        let window = HWND(handle as *mut c_void);
        unsafe {
            if visible {
                SetWindowPos(
                    window,
                    Some(HWND_TOP),
                    bounds.x,
                    bounds.y,
                    bounds.width,
                    bounds.height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                )
                .map_err(|error| format!("无法调整 RDP 视图：{error}"))?;
                let _ = ShowWindow(window, SW_SHOW);
            } else {
                let _ = ShowWindow(window, SW_HIDE);
            }
        }
        Ok(())
    }

    pub fn close(manager: &RdpManager, session_id: &str) -> Result<(), String> {
        if let Some(handle) = manager.remove(session_id)? {
            destroy(HWND(handle as *mut c_void));
        }
        Ok(())
    }

    fn configure_control(
        window: HWND,
        host: &str,
        port: u16,
        username: &str,
        admin_session: bool,
        bounds: PhysicalRdpBounds,
    ) -> Result<(), String> {
        let control = control_dispatch(window)?;
        put_property(&control, "Server", host.into())?;
        if !username.is_empty() {
            put_property(&control, "UserName", username.into())?;
        }
        put_property(&control, "DesktopWidth", bounds.width.max(640).into())?;
        put_property(&control, "DesktopHeight", bounds.height.max(480).into())?;
        put_property(&control, "ColorDepth", 32i32.into())?;

        let advanced = get_dispatch_property(&control, "AdvancedSettings2")?;
        put_property(&advanced, "RDPPort", i32::from(port).into())?;
        let _ = put_property(&advanced, "SmartSizing", true.into());
        let _ = put_property(&advanced, "RedirectClipboard", true.into());
        if admin_session {
            let _ = put_property(&advanced, "ConnectToAdministerServer", true.into());
        }

        invoke_method(&control, "Connect")
    }

    fn control_dispatch(window: HWND) -> Result<IDispatch, String> {
        let mut raw = std::ptr::null_mut();
        unsafe {
            (atl_api()?.get_control)(window, &mut raw)
                .ok()
                .map_err(|error| format!("无法访问 Windows RDP 控件：{error}"))?;
            if raw.is_null() {
                return Err("Windows RDP 控件没有返回可用接口".to_owned());
            }
            IUnknown::from_raw(raw)
                .cast::<IDispatch>()
                .map_err(|error| format!("Windows RDP 控件接口不可用：{error}"))
        }
    }

    fn dispatch_id(dispatch: &IDispatch, name: &str) -> Result<i32, String> {
        let wide = name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let names = [PCWSTR(wide.as_ptr())];
        let iid = GUID::default();
        let mut id = 0;
        unsafe {
            dispatch
                .GetIDsOfNames(&iid, names.as_ptr(), 1, 0, &mut id)
                .map_err(|error| format!("RDP 控件不支持 {name}：{error}"))?;
        }
        Ok(id)
    }

    pub(super) fn atl_api() -> Result<&'static AtlApi, String> {
        static API: std::sync::OnceLock<Result<AtlApi, String>> = std::sync::OnceLock::new();
        API.get_or_init(|| unsafe {
            let module = LoadLibraryW(w!("atl.dll"))
                .map_err(|error| format!("无法加载 Windows ATL 宿主：{error}"))?;
            let initialize = GetProcAddress(module, s!("AtlAxWinInit"))
                .ok_or("Windows ATL 缺少 AtlAxWinInit")?;
            let get_control = GetProcAddress(module, s!("AtlAxGetControl"))
                .ok_or("Windows ATL 缺少 AtlAxGetControl")?;
            Ok(AtlApi {
                initialize: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    AtlAxWinInitFn,
                >(initialize),
                get_control: std::mem::transmute::<
                    unsafe extern "system" fn() -> isize,
                    AtlAxGetControlFn,
                >(get_control),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
    }

    fn ensure_ole_initialized() -> Result<(), String> {
        OLE_READY.with(|ready| {
            if ready.get() {
                return Ok(());
            }
            unsafe {
                OleInitialize(None)
                    .map_err(|error| format!("Windows RDP 组件初始化失败：{error}"))?;
            }
            ready.set(true);
            Ok(())
        })
    }

    fn put_property(dispatch: &IDispatch, name: &str, mut value: VARIANT) -> Result<(), String> {
        let id = dispatch_id(dispatch, name)?;
        let iid = GUID::default();
        let mut property_put = DISPID_PROPERTYPUT;
        let parameters = DISPPARAMS {
            rgvarg: &mut value,
            rgdispidNamedArgs: &mut property_put,
            cArgs: 1,
            cNamedArgs: 1,
        };
        unsafe {
            dispatch
                .Invoke(
                    id,
                    &iid,
                    0,
                    DISPATCH_PROPERTYPUT,
                    &parameters,
                    None,
                    None,
                    None,
                )
                .map_err(|error| format!("无法设置 RDP 属性 {name}：{error}"))
        }
    }

    fn get_dispatch_property(dispatch: &IDispatch, name: &str) -> Result<IDispatch, String> {
        let id = dispatch_id(dispatch, name)?;
        let iid = GUID::default();
        let parameters = DISPPARAMS::default();
        let mut result = VARIANT::default();
        unsafe {
            dispatch
                .Invoke(
                    id,
                    &iid,
                    0,
                    DISPATCH_PROPERTYGET,
                    &parameters,
                    Some(&mut result),
                    None,
                    None,
                )
                .map_err(|error| format!("无法读取 RDP 属性 {name}：{error}"))?;
        }
        IDispatch::try_from(&result).map_err(|error| format!("RDP 属性 {name} 类型无效：{error}"))
    }

    fn invoke_method(dispatch: &IDispatch, name: &str) -> Result<(), String> {
        let id = dispatch_id(dispatch, name)?;
        let iid = GUID::default();
        let parameters = DISPPARAMS::default();
        unsafe {
            dispatch
                .Invoke(id, &iid, 0, DISPATCH_METHOD, &parameters, None, None, None)
                .map_err(|error| format!("无法调用 RDP 操作 {name}：{error}"))
        }
    }

    fn destroy(window: HWND) {
        if let Ok(control) = control_dispatch(window) {
            let _ = invoke_method(&control, "Disconnect");
        }
        unsafe {
            let _ = DestroyWindow(window);
        }
    }

    pub(super) fn validate_session_id(session_id: &str) -> Result<(), String> {
        if session_id.is_empty()
            || !session_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err("RDP 会话标识无效".to_owned());
        }
        Ok(())
    }

    pub(super) fn validate_connection(host: &str, port: u16, username: &str) -> Result<(), String> {
        if host.trim().is_empty() || port == 0 {
            return Err("RDP 主机地址或端口无效".to_owned());
        }
        for (label, value) in [("主机地址", host), ("账号", username)] {
            if value.contains(['\r', '\n']) {
                return Err(format!("{label}包含无效换行符"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_css_bounds_to_physical_pixels() {
        let bounds = RdpBounds {
            x: 10.2,
            y: 20.4,
            width: 800.0,
            height: 600.0,
        }
        .physical(1.25);
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (13, 26, 1000, 750)
        );
    }

    #[cfg(windows)]
    #[test]
    fn loads_windows_rdp_host_exports() {
        windows_host::atl_api().expect("load ATL RDP hosting exports");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_rdp_control_injection() {
        assert!(
            windows_host::validate_connection("server\r\nredirectclipboard:i:1", 3389, "").is_err()
        );
        assert!(windows_host::validate_connection("server", 3389, "DOMAIN\\operator").is_ok());
        assert!(windows_host::validate_session_id("../session").is_err());
    }
}
