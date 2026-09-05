import type { AiSettings } from "./types";

interface AiSettingsViewProps {
  settings: AiSettings;
  onChange: (patch: Partial<AiSettings>) => void;
  onReset: () => void;
}

export function AiSettingsView({ settings, onChange, onReset }: AiSettingsViewProps) {
  return (
    <div className="settings-view">
      <div className="settings-view-heading"><span className="settings-kicker">AI ASSISTANT</span><h1>AI 助手</h1><p>配置分析服务。API 密钥只在本次运行中使用，不会写入设置。</p></div>
      <section className="settings-card">
        <div className="settings-row"><span><strong>启用 AI 助手</strong><small>关闭后终端仍可正常工作</small></span><button aria-checked={settings.enabled} aria-label="启用 AI 助手" className="switch" data-active={settings.enabled} onClick={() => onChange({ enabled: !settings.enabled })} role="switch" type="button"><span /></button></div>
        <label className="settings-row"><span><strong>运行方式</strong><small>OpenAI 兼容 API 或本地 CLI</small></span><select value={settings.providerMode} onChange={(event) => onChange({ providerMode: event.target.value as AiSettings["providerMode"] })}><option value="api">兼容 API</option><option value="process">本地进程</option></select></label>
        {settings.providerMode === "api" ? <>
          <label className="settings-field"><span>服务地址</span><input value={settings.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
          <label className="settings-field"><span>模型</span><input value={settings.model} onChange={(event) => onChange({ model: event.target.value })} placeholder="gpt-4o-mini" /></label>
          <label className="settings-field"><span>温度</span><input max="2" min="0" step="0.1" type="number" value={settings.temperature} onChange={(event) => onChange({ temperature: Number(event.target.value) })} /></label>
        </> : <>
          <label className="settings-row"><span><strong>CLI 预设</strong><small>Claude / OpenCode / PowerShell / 自定义</small></span><select value={settings.providerPreset} onChange={(event) => onChange({ providerPreset: event.target.value as AiSettings["providerPreset"] })}><option value="claude">Claude CLI</option><option value="opencode">OpenCode CLI</option><option value="powershell">PowerShell 脚本</option><option value="custom">自定义 CLI</option></select></label>
          <label className="settings-field"><span>可执行文件</span><input value={settings.executable} onChange={(event) => onChange({ executable: event.target.value })} placeholder="claude / opencode / powershell.exe" /></label>
          {settings.providerPreset === "powershell" && <label className="settings-field"><span>脚本路径</span><input value={settings.scriptPath} onChange={(event) => onChange({ scriptPath: event.target.value })} placeholder="C:\\Scripts\\assistant.ps1" /></label>}
          <label className="settings-field"><span>参数（每行一个）</span><textarea rows={3} value={settings.arguments.join("\n")} onChange={(event) => onChange({ arguments: event.target.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) })} /></label>
          <label className="settings-field"><span>工作目录</span><input value={settings.cwd} onChange={(event) => onChange({ cwd: event.target.value })} /></label>
        </>}
        <label className="settings-field"><span>超时时间（毫秒）</span><input max="600000" min="1000" step="1000" type="number" value={settings.timeoutMs} onChange={(event) => onChange({ timeoutMs: Number(event.target.value) })} /></label>
      </section>
      <button className="settings-reset" onClick={onReset} type="button">恢复默认</button>
    </div>
  );
}
