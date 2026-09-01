import type {
  AppearanceTheme,
  TerminalColorScheme,
  TerminalCursorStyle,
  TerminalFontWeight,
  TerminalHighlightRule,
  TerminalSettings,
} from "./types";
import { resolveTerminalTheme } from "../terminal/themes";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CloseIcon } from "../workbench/icons";

interface TerminalSettingsViewProps {
  active: boolean;
  appearanceTheme: AppearanceTheme;
  settings: TerminalSettings;
  onChange: (settings: Partial<TerminalSettings>) => void;
  onOpenKeyboardShortcuts: () => void;
  onReset: () => void;
}

const cursorStyles: Array<{ id: TerminalCursorStyle; label: string }> = [
  { id: "block", label: "方块" },
  { id: "bar", label: "竖线" },
  { id: "underline", label: "下划线" },
];

const colorSchemes: Array<{ id: TerminalColorScheme; name: string; description: string }> = [
  { id: "adaptive", name: "自动", description: "跟随应用外观" },
  { id: "graphite", name: "石墨", description: "深色外观 · 低眩光" },
  { id: "paper", name: "纸张", description: "暖色外观 · 柔和低眩光" },
];

export function TerminalSettingsView({
  active,
  appearanceTheme,
  settings,
  onChange,
  onOpenKeyboardShortcuts,
  onReset,
}: TerminalSettingsViewProps) {
  const previewTheme = resolveTerminalTheme(settings.colorScheme, appearanceTheme);

  return (
    <section className="settings-view workspace-view" aria-hidden={!active} data-active={active} aria-label="终端设置">
      <div className="settings-scroll-area">
        <header className="settings-heading">
          <div>
            <p className="settings-eyebrow">外观与体验</p>
            <h1>终端</h1>
            <p>调整阅读密度、光标反馈与颜色。更改会立即应用到所有终端。</p>
          </div>
          <div className="settings-heading-actions">
            <button className="secondary-button" onClick={onOpenKeyboardShortcuts} type="button">键盘快捷键</button>
            <button className="secondary-button" onClick={onReset} type="button">恢复默认</button>
          </div>
        </header>

        <div className="settings-layout">
          <div className="settings-sections">
            <SettingsGroup title="字体">
              <SettingRow label="字体族" description="按顺序使用系统中已安装的等宽字体。">
                <input
                  aria-label="字体族"
                  className="settings-text-input"
                  onChange={(event) => onChange({ fontFamily: event.target.value })}
                  spellCheck={false}
                  value={settings.fontFamily}
                />
              </SettingRow>
              <SettingRow label="字号" description={`${settings.fontSize}px`}>
                <input aria-label="字号" type="range" min={11} max={22} step={1} value={settings.fontSize}
                  onChange={(event) => onChange({ fontSize: Number(event.target.value) })} />
              </SettingRow>
              <SettingRow label="行距" description={settings.lineHeight.toFixed(2)}>
                <input aria-label="行距" type="range" min={1} max={1.5} step={0.02} value={settings.lineHeight}
                  onChange={(event) => onChange({ lineHeight: Number(event.target.value) })} />
              </SettingRow>
              <SettingRow label="字重">
                <SegmentedControl
                  items={([{ value: 400, label: "常规" }, { value: 500, label: "中等" }, { value: 600, label: "半粗" }] as const)}
                  onChange={(fontWeight) => onChange({ fontWeight: fontWeight as TerminalFontWeight })}
                  value={settings.fontWeight}
                />
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="光标与缓冲">
              <SettingRow label="光标形状">
                <SegmentedControl
                  items={cursorStyles.map((cursor) => ({ value: cursor.id, label: cursor.label }))}
                  onChange={(cursorStyle) => onChange({ cursorStyle })}
                  value={settings.cursorStyle}
                />
              </SettingRow>
              <SettingRow label="光标闪烁" description="帮助快速定位当前输入位置。">
                <button className="switch" aria-label="光标闪烁" aria-checked={settings.cursorBlink} data-active={settings.cursorBlink}
                  onClick={() => onChange({ cursorBlink: !settings.cursorBlink })} role="switch" type="button"><span /></button>
              </SettingRow>
              <SettingRow label="滚动缓冲" description="每个标签保留的最大历史行数。">
                <SegmentedControl
                  compact
                  items={([1_000, 5_000, 10_000, 50_000] as const).map((scrollback) => ({ value: scrollback, label: `${scrollback / 1_000}k` }))}
                  onChange={(scrollback) => onChange({ scrollback })}
                  value={settings.scrollback}
                />
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup title="ANSI 配色">
              <div className="scheme-grid">
                {colorSchemes.map((scheme) => {
                  const palette = resolveTerminalTheme(scheme.id, appearanceTheme);
                  return (
                    <button className="scheme-card" data-active={settings.colorScheme === scheme.id} key={scheme.id}
                      onClick={() => onChange({ colorScheme: scheme.id })} type="button">
                      <span className="scheme-swatches">
                        {[palette.red, palette.yellow, palette.green, palette.blue].map((color) =>
                          <i key={color} style={{ background: color }} />)}
                      </span>
                      <strong>{scheme.name}</strong><small>{scheme.description}</small>
                    </button>
                  );
                })}
              </div>
              <div className="terminal-preview" style={{ background: previewTheme.background, color: previewTheme.foreground }}>
                <div className="preview-title">
                  <span>实时预览</span>
                  <span>{settings.colorScheme === "adaptive" ? "自动" : colorSchemes.find((scheme) => scheme.id === settings.colorScheme)?.name}</span>
                </div>
                <pre style={{ fontFamily: settings.fontFamily, fontSize: settings.fontSize, fontWeight: settings.fontWeight, lineHeight: settings.lineHeight }}>
                  <span style={{ color: previewTheme.green }}>❯</span> ssh edge-node{`\n`}
                  <span style={{ color: previewTheme.blue }}>info</span>  Connected to 10.0.0.8{`\n`}
                  <span style={{ color: previewTheme.yellow }}>warn</span>  2 updates available{`\n`}
                  <span style={{ color: previewTheme.red }}>error</span> retry required
                </pre>
              </div>
            </SettingsGroup>

            <SettingsGroup title="文字着色">
              <HighlightRulesEditor
                onChange={(highlightRules) => onChange({ highlightRules })}
                rules={settings.highlightRules}
              />
            </SettingsGroup>
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingsGroup({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="settings-group"><h2>{title}</h2><div className="settings-card">{children}</div></section>;
}

function SettingRow({ children, description, label }: { children: React.ReactNode; description?: string; label: string }) {
  return <div className="setting-row"><span><strong>{label}</strong>{description && <small>{description}</small>}</span><div className="setting-control">{children}</div></div>;
}

function HighlightRulesEditor({
  onChange,
  rules,
}: {
  onChange: (rules: TerminalHighlightRule[]) => void;
  rules: TerminalHighlightRule[];
}) {
  const updateRule = (ruleId: string, patch: Partial<TerminalHighlightRule>) => {
    onChange(rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule));
  };

  const addRule = () => {
    onChange([...rules, {
      id: crypto.randomUUID(),
      enabled: true,
      matchMode: "text",
      pattern: "",
      color: "#FFB86C",
      caseSensitive: false,
    }]);
  };

  return (
    <div className="highlight-rules-editor">
      <div className="highlight-rules-intro">
        <div>
          <strong>匹配终端内容</strong>
          <small>按规则顺序匹配纯文本或正则表达式，并覆盖匹配文字的前景色。</small>
        </div>
        <button className="highlight-add-button" onClick={addRule} type="button">添加规则</button>
      </div>

      {rules.length === 0 ? (
        <div className="highlight-empty">尚未添加着色规则</div>
      ) : (
        <div className="highlight-rule-list">
          {rules.map((rule, index) => {
            const regexValid = rule.matchMode !== "regex" || isValidRegex(rule.pattern);
            const colorValid = isValidHexColor(rule.color);
            return (
              <section className="highlight-rule" data-enabled={rule.enabled} key={rule.id}>
                <header>
                  <button
                    aria-checked={rule.enabled}
                    aria-label={`启用规则 ${index + 1}`}
                    className="switch compact-switch"
                    data-active={rule.enabled}
                    onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}
                    role="switch"
                    type="button"
                  ><span /></button>
                  <strong>规则 {index + 1}</strong>
                  <span className="highlight-rule-spacer" />
                  <button
                    aria-label={`删除规则 ${index + 1}`}
                    className="highlight-remove-button"
                    onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}
                    type="button"
                  ><CloseIcon /></button>
                </header>
                <div className="highlight-rule-grid">
                  <label className="highlight-match-mode">
                    <span>匹配方式</span>
                    <SegmentedControl
                      compact
                      items={[{ value: "text", label: "文本" }, { value: "regex", label: "正则" }] as const}
                      onChange={(matchMode) => updateRule(rule.id, { matchMode })}
                      value={rule.matchMode}
                    />
                  </label>
                  <label className="highlight-pattern-field">
                    <span>{rule.matchMode === "text" ? "匹配文本" : "正则表达式"}</span>
                    <input
                      aria-invalid={!regexValid}
                      className="settings-text-input"
                      onChange={(event) => updateRule(rule.id, { pattern: event.target.value })}
                      placeholder={rule.matchMode === "text" ? "例如 ERROR" : "例如 ERROR|FAILED"}
                      spellCheck={false}
                      value={rule.pattern}
                    />
                    {!regexValid && <small className="field-error">正则表达式格式无效</small>}
                  </label>
                  <label className="highlight-color-field">
                    <span>文字颜色</span>
                    <div className="highlight-color-control" data-invalid={!colorValid}>
                      <input
                        aria-label="十六进制颜色"
                        maxLength={7}
                        onChange={(event) => updateRule(rule.id, { color: event.target.value.toUpperCase() })}
                        placeholder="#FFFFFF"
                        spellCheck={false}
                        type="text"
                        value={rule.color}
                      />
                      <input
                        aria-label="打开调色盘"
                        onChange={(event) => updateRule(rule.id, { color: event.target.value.toUpperCase() })}
                        type="color"
                        value={colorValid ? rule.color : "#FFFFFF"}
                      />
                    </div>
                    {!colorValid && <small className="field-error">请输入六位十六进制颜色</small>}
                  </label>
                  <label className="highlight-case-option">
                    <input
                      checked={rule.caseSensitive}
                      onChange={(event) => updateRule(rule.id, { caseSensitive: event.target.checked })}
                      type="checkbox"
                    />
                    <span>区分大小写</span>
                  </label>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function isValidHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function isValidRegex(value: string) {
  if (!value) return true;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
