import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type {
  TerminalCapability,
  TerminalContextSnapshot,
  TerminalSessionDescriptor,
  TerminalTarget,
} from "../capabilities/terminal";
import { systemApi } from "../ipc/system";
import { Select, type SelectOption } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { ConfigurationIcon, PlusIcon, TrashIcon } from "../workbench/icons";
import { buildConfig, CONFIG_FEATURES, deriveSmallNetworkIp, isRequiredConfigFeature, toTerminalInput } from "./cfgConfig";
import { CfgDisclosure } from "./CfgDisclosure";
import { useCfgDraft } from "./useCfgDraft";
import type { ConfigFeature, ConfigValues, DeviceType } from "./cfgConfig";

type TargetMode = "active" | "session";
type DeployState = "idle" | "sending" | "success" | "error";
type NoticeTone = "info" | "success" | "error";

const ACTIVE_TARGET_VALUE = "__active_terminal__";

interface CfgPanelProps {
  activeTabId: string | null;
  terminal: TerminalCapability;
}

interface AaaUser {
  id: string;
  username: string;
  password: string;
}

const managementInterfaces = [
  { value: "MEth0/0/0", label: "MEth0/0/0", description: "带外管理接口" },
  { value: "GE0/0/0", label: "GE0/0/0", description: "以太网管理接口" },
  { value: "GE0/0/1", label: "GE0/0/1", description: "以太网管理接口" },
  { value: "GE0/0/2", label: "GE0/0/2", description: "以太网管理接口" },
  { value: "GE0/0/3", label: "GE0/0/3", description: "以太网管理接口" },
  { value: "GE0/0/4", label: "GE0/0/4", description: "以太网管理接口" },
  { value: "GE0/0/5", label: "GE0/0/5", description: "以太网管理接口" },
  { value: "GE0/0/6", label: "GE0/0/6", description: "以太网管理接口" },
] as const;

export function CfgPanel({ activeTabId, terminal }: CfgPanelProps) {
  const { draft, setDraft, saveError } = useCfgDraft();
  const { deviceType, managementInterface, managementIp, localIpv4, aaaUsers, vpnEnabled, vpnName, features } = draft;
  const setDeviceType = (value: DeviceType) => setDraft((current) => ({ ...current, deviceType: value }));
  const setManagementInterface = (value: string) => setDraft((current) => ({ ...current, managementInterface: value }));
  const setManagementIp = (value: string) => setDraft((current) => ({ ...current, managementIp: value }));
  const setLocalIpv4 = (value: string) => setDraft((current) => ({ ...current, localIpv4: value }));
  const setVpnName = (value: string) => setDraft((current) => ({ ...current, vpnName: value }));
  const setAaaUsers = (update: (users: AaaUser[]) => AaaUser[]) => setDraft((current) => ({ ...current, aaaUsers: update(current.aaaUsers) }));
  const toggleFeature = (id: ConfigFeature) => {
    if (isRequiredConfigFeature(id)) return;
    setDraft((current) => ({ ...current, features: { ...current.features, [id]: !current.features[id] } }));
  };
  const [preview, setPreview] = useState("");
  const [previewValues, setPreviewValues] = useState<ConfigValues | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyTimerRef = useRef<number | undefined>(undefined);
  const copyAttemptRef = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  const [targetMode, setTargetMode] = useState<TargetMode>("active");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [deployState, setDeployState] = useState<DeployState>("idle");
  const [, setRuntimeRevision] = useState(0);
  const deployResetTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    return terminal.subscribe(() => setRuntimeRevision((revision) => revision + 1));
  }, [terminal]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyAttemptRef.current += 1;
      clearDeployResetTimer(copyTimerRef);
      if (deployResetTimerRef.current !== undefined) {
        window.clearTimeout(deployResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    void systemApi.getLocalIpv4()
      .then((address) => {
        if (!cancelled && address) setDraft((current) => current.localIpv4 ? current : { ...current, localIpv4: address });
      })
      .catch(() => { /* Keep the restored address if native enumeration is unavailable. */ });
    return () => { cancelled = true; };
  }, []);

  const smallNetworkIp = useMemo(() => deriveSmallNetworkIp(managementIp), [managementIp]);
  const configValues: ConfigValues = draft;
  const previewIsCurrent = previewValues === configValues;
  const localIpv4Options = useMemo(
    () => localIpv4 ? [{ value: localIpv4, label: localIpv4, description: "PPP 适配器 usg" }] : [],
    [localIpv4],
  );

  const sessions = terminal.listSessions();
  const activeContext = activeTabId
    ? terminal.getContextForTab(activeTabId)
    : terminal.getActiveContext();
  const activeDescriptor = activeTabId
    ? sessions.find((session) => session.tabId === activeTabId)
    : undefined;
  const activeTarget = activeContext?.target ?? targetFromDescriptor(activeDescriptor);
  const availableSessions = sessions.filter((session) => Boolean(session.sessionId));
  const activeDisplay = activeContext
    ? { title: activeContext.title, description: connectionSummary(activeContext.connection) }
    : activeDescriptor?.sessionId
      ? { title: activeDescriptor.title, description: connectionSummary(activeDescriptor.connection) }
      : undefined;
  const targetOptions: SelectOption<string>[] = availableSessions.length > 0 ? [
    {
      value: ACTIVE_TARGET_VALUE,
      label: activeDisplay ? `当前 · ${activeDisplay.title}` : "当前活动终端",
      description: activeDisplay?.description ?? "暂无可用活动终端",
      disabled: !activeTarget,
    },
    ...availableSessions
      .map((session) => ({
        value: session.sessionId as string,
        label: session.title,
        description: connectionSummary(session.connection),
      })),
  ] : [];
  const selectedDescriptor = selectedSessionId
    ? availableSessions.find((session) => session.sessionId === selectedSessionId)
    : undefined;
  const target: TerminalTarget | undefined = targetMode === "active"
    ? activeTarget
    : targetFromDescriptor(selectedDescriptor);
  const targetState = targetMode === "active"
    ? activeContext?.connectionState ?? activeDescriptor?.connectionState
    : selectedDescriptor?.connectionState;
  const targetTitle = targetMode === "active"
    ? activeDisplay?.title
    : selectedDescriptor?.title;
  const targetSelectValue = availableSessions.length === 0
    ? ""
    : targetMode === "active" ? ACTIVE_TARGET_VALUE : selectedSessionId ?? "";
  const targetHint = availableSessions.length === 0
    ? "请先打开一个终端会话。"
    : !target
      ? targetMode === "session" ? "所选终端已不可用，请重新选择。" : "当前活动终端不可用，请选择其他会话。"
      : targetState !== "connected" ? "目标终端尚未就绪。" : null;
  // AAA has its own access row and switch; this aggregate controls only the
  // optional feature rows shown in the configuration grid.
  const optionalFeatureIds = CONFIG_FEATURES
    .filter(({ id }) => !isRequiredConfigFeature(id) && id !== "aaa")
    .map(({ id }) => id);
  const allOptionalEnabled = optionalFeatureIds.every((id) => features[id]);

  const toggleAllOptional = () => {
    setDraft((current) => {
      const nextFeatures = { ...current.features };
      const nextEnabled = !allOptionalEnabled;
      optionalFeatureIds.forEach((id) => { nextFeatures[id] = nextEnabled; });
      return { ...current, features: nextFeatures };
    });
  };

  const updateUser = (id: string, patch: Partial<Omit<AaaUser, "id">>) => {
    setAaaUsers((users) => users.map((user) => user.id === id ? { ...user, ...patch } : user));
  };

  const addUser = () => {
    setAaaUsers((users) => [...users, {
      id: `user-${Date.now()}`,
      username: `user${users.length + 1}`,
      password: "",
    }]);
  };

  const removeUser = (id: string) => {
    setAaaUsers((users) => users.length > 1 ? users.filter((user) => user.id !== id) : users);
  };

  const generatePreview = () => {
    clearDeployResetTimer(deployResetTimerRef);
    setDeployState("idle");
    copyAttemptRef.current += 1;
    clearDeployResetTimer(copyTimerRef);
    setCopyState("idle");
    try {
      setPreview(buildConfig(configValues));
      setPreviewValues(configValues);
      setNoticeTone("info");
      setNotice(null);
    } catch (error) {
      setPreview("");
      setPreviewValues(null);
      setNoticeTone("error");
      setNotice(error instanceof Error ? error.message : "配置生成失败，请检查输入。");
    }
  };

  const deployPreview = async () => {
    if (!preview || !previewIsCurrent || deployState === "sending" || deployState === "success") return;
    if (!target) {
      setDeployState("error");
      setNoticeTone("error");
      setNotice("当前目标终端不可用，请先打开并选择一个终端。");
      return;
    }
    if (targetState !== "connected") {
      setDeployState("error");
      setNoticeTone("error");
      setNotice("目标终端尚未连接完成，暂时无法下发配置。");
      return;
    }

    clearDeployResetTimer(deployResetTimerRef);
    setDeployState("sending");
    setNoticeTone("info");
    setNotice("正在下发配置…");
    try {
      const result = await Promise.resolve(terminal.dispatchInput(target, toTerminalInput(preview)));
      if (!mountedRef.current) return;
      if (!result.ok) {
        setDeployState("error");
        setNoticeTone("error");
        setNotice(result.code === "stale_session"
          ? "目标终端已切换或重新连接，请重新选择后再下发。"
          : "目标终端暂时无法接收输入。");
        return;
      }
      setDeployState("success");
      setNoticeTone("success");
      setNotice(`配置已提交到「${targetTitle ?? "终端"}」的输入队列，请查看设备回显确认执行结果。`);
      deployResetTimerRef.current = window.setTimeout(() => {
        deployResetTimerRef.current = undefined;
        if (mountedRef.current) setDeployState("idle");
      }, 1_800);
    } catch {
      if (!mountedRef.current) return;
      setDeployState("error");
      setNoticeTone("error");
      setNotice("配置下发失败，请检查目标终端连接状态。");
    }
  };

  const copyPreview = async () => {
    const attempt = ++copyAttemptRef.current;
    clearDeployResetTimer(copyTimerRef);
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(preview);
      if (!mountedRef.current || attempt !== copyAttemptRef.current) return;
      setCopyState("copied");
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = undefined;
        if (mountedRef.current) setCopyState("idle");
      }, 1_800);
    } catch {
      if (!mountedRef.current || attempt !== copyAttemptRef.current) return;
      setCopyState("idle");
      setNoticeTone("error");
      setNotice("复制失败，请检查系统剪贴板权限后重试。");
    }
  };

  return (
    <div className="cfg-panel">
      <div className="cfg-body">
        <header className="cfg-heading">
          <span className="cfg-heading-icon" aria-hidden="true"><ConfigurationIcon /></span>
          <div><h2>设备启动配置</h2><p>配置管理入口，预览后下发。</p></div>
        </header>

        <section className="cfg-section" aria-label="设备参数">
          <div className="cfg-device-type">
            <SegmentedControl
              ariaLabel="设备类型"
              items={[{ value: "FW", label: "FW · 防火墙" }, { value: "AR", label: "AR · 路由器" }] as const}
              onChange={setDeviceType}
              value={deviceType}
            />
          </div>
          <div className="cfg-surface cfg-device-fields">
            <div className="cfg-field">
              <span>管理接口</span>
              <Select ariaLabel="管理接口" className="cfg-select" onChange={setManagementInterface} options={managementInterfaces} value={managementInterface} />
            </div>
            <label className="cfg-field">
              <span>管理口 IP</span>
              <input inputMode="decimal" onChange={(event) => setManagementIp(event.target.value)} value={managementIp} />
              <small>网关 {smallNetworkIp || "—"} · /24</small>
            </label>
            <div className="cfg-field">
              <span>本机网卡 IPv4</span>
              <Select
                ariaLabel="本机网卡 IPv4"
                className="cfg-select"
                emptyLabel="未找到可用网卡 IPv4"
                onChange={setLocalIpv4}
                options={localIpv4Options}
                placeholder="未检测到可用地址"
                value={localIpv4}
              />
            </div>
          </div>
        </section>

        <section className="cfg-section" aria-label="访问配置">
          <h3 className="cfg-section-title">访问配置</h3>
          <div className="cfg-surface cfg-access-list">
            <CfgDisclosure title="管理用户 AAA" subtitle={`${aaaUsers.length} 位用户 · ${aaaUsers.map((user) => user.username || "未命名").join("、")}`} enabled={features.aaa} onEnable={() => toggleFeature("aaa")}>
              <div className="cfg-access-editor">
                {aaaUsers.map((user, index) => (
                  <div className="cfg-user" key={user.id}>
                    <div className="cfg-user-editor">
                      <div className="cfg-user-heading">
                        <span>用户 {index + 1}</span>
                        {aaaUsers.length > 1 && <button aria-label="删除用户" className="cfg-user-menu" onClick={() => removeUser(user.id)} title="删除用户" type="button"><TrashIcon /></button>}
                      </div>
                      <div className="cfg-grid">
                        <label className="cfg-field"><span>用户名</span><input onChange={(event) => updateUser(user.id, { username: event.target.value })} value={user.username} /></label>
                        <label className="cfg-field"><span>密码</span><input onChange={(event) => updateUser(user.id, { password: event.target.value })} type="text" autoComplete="off" spellCheck={false} value={user.password} /></label>
                      </div>
                    </div>
                  </div>
                ))}
                <button className="cfg-add-user" onClick={addUser} type="button"><PlusIcon />添加用户</button>
              </div>
            </CfgDisclosure>
            <CfgDisclosure title="VPN 实例" subtitle={vpnName || "未命名"} enabled={vpnEnabled} onEnable={() => setDraft((current) => ({ ...current, vpnEnabled: !current.vpnEnabled }))}>
              <label className="cfg-field cfg-vpn-field"><span>实例名称</span><input onChange={(event) => setVpnName(event.target.value)} value={vpnName} /></label>
            </CfgDisclosure>
          </div>
        </section>

        <section className="cfg-section" aria-label="配置功能">
          <div className="cfg-section-heading">
            <h3 className="cfg-section-title">配置功能</h3>
            <div className="cfg-feature-master">
              <span>全部启用</span>
              <button
                aria-checked={allOptionalEnabled}
                aria-label="全部启用可选功能"
                className="switch"
                data-active={allOptionalEnabled}
                onClick={toggleAllOptional}
                role="switch"
                type="button"
              ><span /></button>
            </div>
          </div>
          <div className="cfg-features">
            <div className="cfg-feature-row cfg-feature-base">
              <span className="cfg-feature-base-copy"><strong>基础管理配置</strong><small>管理口路由 · LLDP · Telnet</small></span>
              <small className="cfg-feature-required-label">必需</small>
            </div>
            {CONFIG_FEATURES.filter(({ id }) => !isRequiredConfigFeature(id) && id !== "aaa").map(({ id, label }) => (
              <div className="cfg-feature-row" key={id}>
                <label htmlFor={`cfg-feature-${id}`}>{label}</label>
                <button id={`cfg-feature-${id}`} aria-label={`启用${label}`} className="switch" role="switch" aria-checked={features[id]} data-active={features[id]} onClick={() => toggleFeature(id)} type="button"><span /></button>
              </div>
            ))}
          </div>
        </section>

        <section className="cfg-section cfg-target-section" aria-label="下发目标">
          <h3 className="cfg-section-title">目标终端</h3>
          <Select
            ariaLabel="目标终端"
            className="cfg-select"
            emptyLabel="暂无可用终端"
            onChange={(value) => {
              if (value === ACTIVE_TARGET_VALUE) {
                setTargetMode("active");
                return;
              }
              setTargetMode("session");
              setSelectedSessionId(value);
            }}
            options={targetOptions}
            placeholder="暂无可用终端"
            value={targetSelectValue}
          />
          {targetHint && <p className="cfg-target-hint">{targetHint}</p>}

        </section>

        {preview && (
          <section className="cfg-preview-card">
            <div className="cfg-preview-heading">
              <strong>配置结果</strong>
              <button type="button" className="cfg-copy" onClick={() => { void copyPreview(); }}>{copyState === "copied" ? "✓ 已复制" : "复制配置"}</button>
            </div>
            {!previewIsCurrent && <p className="cfg-preview-stale">参数已变更，请重新生成。</p>}
            <pre tabIndex={0} aria-label="生成的配置文本">{preview}</pre>
          </section>
        )}
      </div>

      <footer className="cfg-operation-group">
        {saveError && <p className="cfg-notice cfg-notice-error" role="status">草稿保存失败，请检查本地存储权限。</p>}
        {notice && <p aria-live="polite" className={`cfg-notice cfg-notice-${noticeTone}`} role="status">{notice}</p>}
        <div className="cfg-actions">
          <button className="secondary-button" onClick={generatePreview} type="button">生成配置</button>
          <button
            aria-busy={deployState === "sending"}
            className="primary-button"
            disabled={!preview || !previewIsCurrent || !target || targetState !== "connected" || deployState === "sending" || deployState === "success"}
            onClick={() => { void deployPreview(); }}
            type="button"
          >
            <span className="cfg-button-content">
              {deployState === "sending" && <span aria-hidden="true" className="cfg-spinner" />}
              {deployState === "success" ? "✓ 已下发" : deployState === "sending" ? "正在下发…" : "下发配置"}
            </span>
          </button>
        </div>
      </footer>
    </div>
  );
}
function targetFromDescriptor(descriptor: TerminalSessionDescriptor | undefined): TerminalTarget | undefined {
  return descriptor?.sessionId ? { tabId: descriptor.tabId, sessionId: descriptor.sessionId } : undefined;
}

function connectionSummary(connection: TerminalSessionDescriptor["connection"] | TerminalContextSnapshot["connection"]) {
  if (connection.kind === "local") return `本地 · ${connection.shell}`;
  if (connection.kind === "serial") return `串口 · ${connection.portName}`;
  return `${connection.kind === "ssh" ? "SSH" : "Telnet"} · ${connection.host}:${connection.port}`;
}

function clearDeployResetTimer(timerRef: MutableRefObject<number | undefined>) {
  if (timerRef.current === undefined) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = undefined;
}
