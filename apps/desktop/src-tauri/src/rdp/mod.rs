use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
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

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpRuntimeStatus {
    pub state: RdpRuntimeState,
    pub disconnect_reason: Option<String>,
    pub focused: bool,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RdpRuntimeState {
    Initializing,
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Clone, Default)]
pub struct RdpManager {
    sessions: Arc<Mutex<HashMap<String, RdpSessionState>>>,
}

enum RdpSessionState {
    Connecting(Arc<AtomicBool>),
    Connected {
        cancellation: Arc<AtomicBool>,
        handle: isize,
        parent: isize,
    },
}

impl RdpManager {
    pub fn begin(&self, session_id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "RDP 会话状态不可用".to_owned())?;
        match sessions.entry(session_id.to_owned()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(RdpSessionState::Connecting(Arc::clone(&cancellation)));
            }
            std::collections::hash_map::Entry::Occupied(_) => {
                return Err("RDP 会话已存在".to_owned());
            }
        }
        Ok(cancellation)
    }

    #[cfg(windows)]
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        root: windows::Win32::Foundation::HWND,
        session_id: String,
        host: &str,
        port: u16,
        username: &str,
        admin_session: bool,
        bounds: PhysicalRdpBounds,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let result = windows_host::create(
            self,
            root,
            session_id.clone(),
            host,
            port,
            username,
            admin_session,
            bounds,
            Arc::clone(&cancellation),
        );
        if result.is_err() {
            self.cancel_connecting(&session_id, &cancellation);
        }
        result
    }

    #[cfg(windows)]
    pub fn resize(
        &self,
        root: windows::Win32::Foundation::HWND,
        session_id: &str,
        bounds: PhysicalRdpBounds,
        visible: bool,
    ) -> Result<(), String> {
        windows_host::resize(self, root, session_id, bounds, visible)
    }

    #[cfg(windows)]
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        windows_host::close(self, session_id)
    }

    #[cfg(windows)]
    pub fn focus(&self, session_id: &str) -> Result<(), String> {
        windows_host::focus(self, session_id)
    }

    /// Destroy every native host. This must be called on the thread that owns
    /// the WebView/ATL windows (the shutdown coordinator dispatches it there).
    #[cfg(windows)]
    pub fn shutdown(&self) -> Result<(), String> {
        let ids = self
            .sessions
            .lock()
            .map_err(|_| "RDP 会话状态不可用".to_owned())?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for session_id in ids {
            self.close(&session_id)?;
        }
        windows_host::uninitialize_ole();
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn shutdown(&self) -> Result<(), String> {
        Ok(())
    }

    #[cfg(windows)]
    pub fn status(&self, session_id: &str) -> Result<RdpRuntimeStatus, String> {
        let handle = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "RDP 会话状态不可用".to_owned())?;
            match sessions.get(session_id) {
                Some(RdpSessionState::Connecting(_)) => {
                    return Ok(RdpRuntimeStatus {
                        state: RdpRuntimeState::Initializing,
                        disconnect_reason: None,
                        focused: false,
                    });
                }
                Some(RdpSessionState::Connected { handle, .. }) => *handle,
                None => {
                    return Ok(RdpRuntimeStatus {
                        state: RdpRuntimeState::Disconnected,
                        disconnect_reason: Some("RDP 会话已关闭".to_owned()),
                        focused: false,
                    });
                }
            }
        };
        windows_host::status(handle)
    }

    #[cfg(not(windows))]
    pub fn unsupported(&self) -> Result<(), String> {
        Err("应用内 RDP 当前仅支持 Windows".to_owned())
    }

    fn finish_connecting(
        &self,
        session_id: &str,
        cancellation: &Arc<AtomicBool>,
        handle: isize,
        parent: isize,
    ) -> Result<bool, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "RDP 会话状态不可用".to_owned())?;
        let is_current = matches!(
            sessions.get(session_id),
            Some(RdpSessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation)
        ) && !cancellation.load(Ordering::Acquire);
        if is_current {
            sessions.insert(
                session_id.to_owned(),
                RdpSessionState::Connected {
                    cancellation: Arc::clone(cancellation),
                    handle,
                    parent,
                },
            );
        }
        Ok(is_current)
    }

    fn get(&self, session_id: &str) -> Result<Option<(isize, isize)>, String> {
        self.sessions
            .lock()
            .map(|sessions| match sessions.get(session_id) {
                Some(RdpSessionState::Connected { handle, parent, .. }) => Some((*handle, *parent)),
                _ => None,
            })
            .map_err(|_| "RDP 会话状态不可用".to_owned())
    }

    fn remove(&self, session_id: &str) -> Result<Option<RdpSessionState>, String> {
        self.sessions
            .lock()
            .map(|mut sessions| sessions.remove(session_id))
            .map_err(|_| "RDP 会话状态不可用".to_owned())
    }

    pub fn cancel_connecting(&self, session_id: &str, cancellation: &Arc<AtomicBool>) {
        cancellation.store(true, Ordering::Release);
        if let Ok(mut sessions) = self.sessions.lock()
            && matches!(
                sessions.get(session_id),
                Some(RdpSessionState::Connecting(current)) if Arc::ptr_eq(current, cancellation)
            )
        {
            sessions.remove(session_id);
        }
    }
}

#[cfg(windows)]
mod windows_host {
    use super::{
        PhysicalRdpBounds, RdpManager, RdpRuntimeState, RdpRuntimeStatus, RdpSessionState,
    };
    use std::{
        cell::Cell,
        ffi::c_void,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };
    #[cfg(test)]
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CLSIDFromProgID, CoCreateInstance};
    use windows::{
        Win32::{
            Foundation::{HWND, LPARAM, POINT, RECT},
            Graphics::Gdi::MapWindowPoints,
            System::{
                Com::{
                    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS,
                    IDispatch,
                },
                LibraryLoader::{GetProcAddress, LoadLibraryW},
                Ole::{DISPID_PROPERTYPUT, OleInitialize, OleUninitialize},
                Variant::VARIANT,
            },
            UI::Input::KeyboardAndMouse::{GetFocus, SetFocus},
            UI::WindowsAndMessaging::{
                BringWindowToTop, CreateWindowExW, DestroyWindow, EnumChildWindows, GetClassNameW,
                GetParent, GetWindowRect, HWND_TOP, SW_HIDE, SW_SHOW, SWP_NOACTIVATE,
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
        root: HWND,
        session_id: String,
        host: &str,
        port: u16,
        username: &str,
        admin_session: bool,
        bounds: PhysicalRdpBounds,
        cancellation: Arc<AtomicBool>,
    ) -> Result<(), String> {
        validate_session_id(&session_id)?;
        validate_connection(host, port, username)?;
        if cancellation.load(Ordering::Acquire) {
            return Err("RDP 连接已取消".to_owned());
        }
        ensure_ole_initialized()?;

        let (parent, window) = create_host_window(root, bounds)?;
        let local_bounds = map_bounds(root, parent, bounds);

        if let Err(error) = configure_control(window, host, port, username, admin_session, bounds) {
            unsafe {
                let _ = DestroyWindow(window);
            }
            return Err(error);
        }

        // Keep the native host hidden until the ActiveX control reports a
        // connected state. This leaves the React status card visible while
        // the native control is negotiating and avoids an opaque black layer.
        let display_result = unsafe {
            SetWindowPos(
                window,
                Some(HWND_TOP),
                local_bounds.x,
                local_bounds.y,
                local_bounds.width,
                local_bounds.height,
                SWP_NOACTIVATE,
            )
            .map_err(|error| format!("无法定位应用内 RDP 视图：{error}"))
        };
        if let Err(error) = display_result {
            destroy(window);
            return Err(error);
        }
        match manager.finish_connecting(
            &session_id,
            &cancellation,
            window.0 as isize,
            parent.0 as isize,
        ) {
            Ok(true) => {}
            Ok(false) => {
                destroy(window);
                return Err("RDP 连接已取消".to_owned());
            }
            Err(error) => {
                destroy(window);
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn resize(
        manager: &RdpManager,
        root: HWND,
        session_id: &str,
        bounds: PhysicalRdpBounds,
        visible: bool,
    ) -> Result<(), String> {
        let Some((handle, parent)) = manager.get(session_id)? else {
            return Ok(());
        };
        let window = HWND(handle as *mut c_void);
        let parent = HWND(parent as *mut c_void);
        let bounds = map_bounds(root, parent, bounds);
        native_log(&format!(
            "resize session={} host={:?} parent={:?} bounds=({},{} {}x{}) visible={}",
            session_id, window, parent, bounds.x, bounds.y, bounds.width, bounds.height, visible,
        ));
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
        match manager.remove(session_id)? {
            Some(RdpSessionState::Connecting(cancellation)) => {
                cancellation.store(true, Ordering::Release);
            }
            Some(RdpSessionState::Connected {
                cancellation,
                handle,
                ..
            }) => {
                cancellation.store(true, Ordering::Release);
                destroy(HWND(handle as *mut c_void));
            }
            None => {}
        }
        Ok(())
    }

    pub fn focus(manager: &RdpManager, session_id: &str) -> Result<(), String> {
        let Some((handle, _)) = manager.get(session_id)? else {
            return Ok(());
        };
        let window = HWND(handle as *mut c_void);
        native_log(&format!("focus session={} host={:?}", session_id, window));
        unsafe {
            let _ = ShowWindow(window, SW_SHOW);
            BringWindowToTop(window).map_err(|error| format!("无法激活 RDP 视图：{error}"))?;
            SetFocus(Some(window)).map_err(|error| format!("无法聚焦 RDP 视图：{error}"))?;
        }
        Ok(())
    }

    pub fn status(handle: isize) -> Result<RdpRuntimeStatus, String> {
        let control = control_dispatch(HWND(handle as *mut c_void))?;
        let connected = get_i16_property(&control, "Connected")?;
        let state = match connected {
            1 => RdpRuntimeState::Connected,
            2 => RdpRuntimeState::Connecting,
            _ => RdpRuntimeState::Disconnected,
        };
        let disconnect_reason = if connected == 0 {
            get_i32_property(&control, "ExtendedDisconnectReason")
                .ok()
                .filter(|reason| *reason != 0)
                .map(describe_disconnect_reason)
        } else {
            None
        };
        let window = HWND(handle as *mut c_void);
        let result = RdpRuntimeStatus {
            state,
            disconnect_reason,
            focused: window_has_focus(window),
        };
        native_log(&format!(
            "status host={:?} state={:?} focused={}",
            window, result.state, result.focused
        ));
        Ok(result)
    }

    fn create_host_window(root: HWND, bounds: PhysicalRdpBounds) -> Result<(HWND, HWND), String> {
        unsafe {
            if !(atl_api()?.initialize)().as_bool() {
                return Err("Windows RDP 宿主初始化失败".to_owned());
            }
        }

        let parent = find_webview_parent(root)?;
        let local_bounds = map_bounds(root, parent, bounds);
        debug_window_hierarchy(root, parent, local_bounds);

        let controls = [
            (w!("MsTscAx.MsTscAx.13"), "MsTscAx 13"),
            (w!("MsTscAx.MsTscAx.12"), "MsTscAx 12"),
            (w!("MsTscAx.MsTscAx.11"), "MsTscAx 11"),
            (w!("MsTscAx.MsTscAx.10"), "MsTscAx 10"),
            (w!("MsTscAx.MsTscAx.9"), "MsTscAx 9"),
            (w!("MsTscAx.MsTscAx.8"), "MsTscAx 8"),
            (w!("MsTscAx.MsTscAx.7"), "MsTscAx 7"),
            (w!("MsTscAx.MsTscAx.6"), "MsTscAx 6"),
            (w!("MsTscAx.MsTscAx"), "MsTscAx"),
        ];
        let mut last_error: Option<String> = None;
        for (control, name) in controls {
            let result = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("AtlAxWin"),
                    control,
                    WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                    local_bounds.x,
                    local_bounds.y,
                    local_bounds.width,
                    local_bounds.height,
                    Some(parent),
                    None,
                    None,
                    None,
                )
            };
            match result {
                Ok(window) => match control_dispatch(window)
                    .and_then(|dispatch| dispatch_id(&dispatch, "Server").map(|_| ()))
                {
                    Ok(()) => return Ok((parent, window)),
                    Err(error) => {
                        native_log(&format!(
                            "ActiveX host={} hwnd={:?} error={}",
                            name, window, error
                        ));
                        unsafe {
                            let _ = DestroyWindow(window);
                        }
                        last_error = Some(format!("{name} 不可用：{error}"));
                    }
                },
                Err(error) => {
                    native_log(&format!("ActiveX host={} create error={}", name, error));
                    last_error = Some(format!("{name} 创建失败：{error}"));
                }
            }
        }
        Err(format!(
            "无法创建应用内 RDP 视图：{}",
            last_error.unwrap_or_else(|| "Windows 没有可用的远程桌面控件".to_owned())
        ))
    }

    #[derive(Clone, Copy)]
    struct WindowNode {
        hwnd: HWND,
        parent: HWND,
        depth: usize,
        rect: RECT,
        visible: bool,
    }

    fn find_webview_parent(root: HWND) -> Result<HWND, String> {
        let mut nodes = Vec::<WindowNode>::new();
        unsafe {
            let result = EnumChildWindows(
                Some(root),
                Some(collect_window_node),
                LPARAM((&mut nodes as *mut Vec<WindowNode>) as isize),
            );
            if !result.as_bool() && nodes.is_empty() {
                return Err("无法枚举主窗口的 WebView2 子窗口".to_owned());
            }
        }

        for node in &nodes {
            native_log(&format!(
                "child={:?} parent={:?} class={} depth={} visible={} rect=({},{} {}x{})",
                node.hwnd,
                node.parent,
                class_name(node.hwnd),
                node.depth,
                node.visible,
                node.rect.left,
                node.rect.top,
                node.rect.right - node.rect.left,
                node.rect.bottom - node.rect.top,
            ));
        }

        let mut candidates = nodes
            .iter()
            .filter(|node| is_webview_container(node.hwnd))
            .copied()
            .collect::<Vec<_>>();
        candidates.sort_by_key(|node| {
            let direct_child = usize::from(node.parent != root);
            let invisible = usize::from(!node.visible);
            (direct_child, invisible, node.depth, -window_area(node.rect))
        });
        let candidate = candidates.first().copied().ok_or_else(|| {
            "无法定位 WebView2 原生宿主窗口；未找到可安全挂载 RDP 的容器".to_owned()
        })?;
        native_log(&format!(
            "root={:?} webviewHost={:?} parent={:?} class={} depth={} rect=({},{} {}x{})",
            root,
            candidate.hwnd,
            candidate.parent,
            class_name(candidate.hwnd),
            candidate.depth,
            candidate.rect.left,
            candidate.rect.top,
            candidate.rect.right - candidate.rect.left,
            candidate.rect.bottom - candidate.rect.top,
        ));
        Ok(candidate.hwnd)
    }

    unsafe extern "system" fn collect_window_node(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let nodes = unsafe { &mut *(lparam.0 as *mut Vec<WindowNode>) };
        let parent = unsafe { GetParent(hwnd).unwrap_or_default() };
        let mut rect = RECT::default();
        let _ = unsafe { GetWindowRect(hwnd, &mut rect) };
        let visible =
            unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() };
        let depth = window_depth(hwnd);
        nodes.push(WindowNode {
            hwnd,
            parent,
            depth,
            rect,
            visible,
        });
        BOOL(1)
    }

    fn window_depth(hwnd: HWND) -> usize {
        let mut depth = 0;
        let mut current = hwnd;
        while depth < 32 {
            let Ok(parent) = (unsafe { GetParent(current) }) else {
                break;
            };
            if parent == HWND::default() {
                break;
            }
            depth += 1;
            current = parent;
        }
        depth
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
        String::from_utf16_lossy(&buffer[..(length.max(0) as usize).min(buffer.len())])
    }

    fn is_webview_container(hwnd: HWND) -> bool {
        let class = class_name(hwnd).to_ascii_lowercase();
        class.starts_with("chrome_widgetwin_") || class.contains("webview") || class.contains("wry")
    }

    fn window_area(rect: RECT) -> i64 {
        i64::from((rect.right - rect.left).max(0)) * i64::from((rect.bottom - rect.top).max(0))
    }

    fn window_has_focus(window: HWND) -> bool {
        let mut focused = unsafe { GetFocus() };
        if focused == HWND::default() {
            return false;
        }
        loop {
            if focused == window {
                return true;
            }
            let Ok(parent) = (unsafe { GetParent(focused) }) else {
                return false;
            };
            if parent == HWND::default() {
                return false;
            }
            focused = parent;
        }
    }

    fn map_bounds(root: HWND, parent: HWND, bounds: PhysicalRdpBounds) -> PhysicalRdpBounds {
        let mut points = [
            POINT {
                x: bounds.x,
                y: bounds.y,
            },
            POINT {
                x: bounds.x.saturating_add(bounds.width),
                y: bounds.y.saturating_add(bounds.height),
            },
        ];
        unsafe {
            let _ = MapWindowPoints(Some(root), Some(parent), &mut points);
        }
        PhysicalRdpBounds {
            x: points[0].x,
            y: points[0].y,
            width: (points[1].x - points[0].x).max(1),
            height: (points[1].y - points[0].y).max(1),
        }
    }

    fn debug_window_hierarchy(root: HWND, parent: HWND, bounds: PhysicalRdpBounds) {
        native_log(&format!(
            "mount root={:?} parent={:?} bounds=({},{} {}x{})",
            root, parent, bounds.x, bounds.y, bounds.width, bounds.height,
        ));
    }

    fn native_log(message: &str) {
        eprintln!("[neterminai][rdp] {message}");
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
        let _ = put_property(&control, "AllowPromptingForCredentials", true.into());
        let _ = put_property(&control, "AllowCredentialSaving", false.into());
        let _ = put_property(&control, "ConnectingText", "正在连接远程桌面…".into());
        let _ = put_property(&control, "DisconnectedText", "远程桌面连接已断开".into());

        let advanced = latest_advanced_settings(&control)?;
        put_property(&advanced, "RDPPort", i32::from(port).into())?;
        let _ = put_property(&advanced, "SmartSizing", true.into());
        let _ = put_property(&advanced, "RedirectClipboard", true.into());
        let _ = put_property(&advanced, "EnableCredSspSupport", true.into());
        let _ = put_property(&advanced, "PromptForCredentials", true.into());
        let _ = put_property(&advanced, "PromptForCredsOnClient", true.into());
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

    #[cfg(test)]
    pub(super) fn registered_control_accepts_server() -> Result<(), String> {
        ensure_ole_initialized()?;
        let class_id = unsafe { CLSIDFromProgID(w!("MsTscAx.MsTscAx")) }
            .map_err(|error| format!("Windows 没有注册 RDP ActiveX 控件：{error}"))?;
        let control: IDispatch = unsafe { CoCreateInstance(&class_id, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("无法创建 RDP ActiveX 控件：{error}"))?;
        put_property(&control, "Server", "127.0.0.1".into())
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
            native_log("OLE initialized on the native window thread");
            ready.set(true);
            Ok(())
        })
    }

    pub(super) fn uninitialize_ole() {
        OLE_READY.with(|ready| {
            if !ready.replace(false) {
                return;
            }
            unsafe {
                OleUninitialize();
            }
            native_log("OLE uninitialized on the native window thread");
        });
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
        let result = get_property(dispatch, name)?;
        IDispatch::try_from(&result).map_err(|error| format!("RDP 属性 {name} 类型无效：{error}"))
    }

    fn get_property(dispatch: &IDispatch, name: &str) -> Result<VARIANT, String> {
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
        Ok(result)
    }

    fn get_i16_property(dispatch: &IDispatch, name: &str) -> Result<i16, String> {
        let result = get_property(dispatch, name)?;
        if let Ok(value) = i16::try_from(&result) {
            return Ok(value);
        }
        let value =
            i32::try_from(&result).map_err(|error| format!("RDP 属性 {name} 类型无效：{error}"))?;
        i16::try_from(value).map_err(|_| format!("RDP 属性 {name} 超出有效范围"))
    }

    fn get_i32_property(dispatch: &IDispatch, name: &str) -> Result<i32, String> {
        let result = get_property(dispatch, name)?;
        i32::try_from(&result).map_err(|error| format!("RDP 属性 {name} 类型无效：{error}"))
    }

    fn latest_advanced_settings(control: &IDispatch) -> Result<IDispatch, String> {
        for name in [
            "AdvancedSettings9",
            "AdvancedSettings8",
            "AdvancedSettings7",
            "AdvancedSettings6",
            "AdvancedSettings5",
            "AdvancedSettings4",
            "AdvancedSettings3",
            "AdvancedSettings2",
        ] {
            if let Ok(settings) = get_dispatch_property(control, name) {
                return Ok(settings);
            }
        }
        Err("Windows RDP 控件没有返回高级设置接口".to_owned())
    }

    fn describe_disconnect_reason(reason: i32) -> String {
        format!("Windows 远程桌面已断开（扩展代码 {reason}）")
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
        native_log(&format!("destroy host={window:?}"));
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
    fn connecting_rdp_session_can_be_cancelled_immediately() {
        let manager = RdpManager::default();
        let cancellation = manager.begin("pending").expect("begin session");

        manager.close("pending").expect("close session");

        assert!(cancellation.load(Ordering::Acquire));
        assert!(manager.sessions.lock().expect("read sessions").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn reports_rdp_lifecycle_before_the_native_control_is_ready() {
        let manager = RdpManager::default();
        manager.begin("pending-status").expect("begin session");

        let pending = manager.status("pending-status").expect("pending status");
        assert_eq!(pending.state, RdpRuntimeState::Initializing);

        manager.close("pending-status").expect("close session");
        let closed = manager.status("pending-status").expect("closed status");
        assert_eq!(closed.state, RdpRuntimeState::Disconnected);
        assert!(closed.disconnect_reason.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn loads_windows_rdp_host_exports() {
        windows_host::atl_api().expect("load ATL RDP hosting exports");
    }

    #[cfg(windows)]
    #[test]
    fn registered_rdp_control_accepts_server_property() {
        windows_host::registered_control_accepts_server()
            .expect("registered RDP control should accept Server");
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
