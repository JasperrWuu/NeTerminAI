import { useState } from "react";
import type {
  AppearanceTheme,
  TerminalColorScheme,
  TerminalCursorStyle,
  TerminalFontWeight,
  TerminalHighlightRule,
  TerminalHighlightSet,
  TerminalSettings,
} from "./types";
import { resolveTerminalTheme } from "../terminal/themes";
import { SegmentedControl } from "../ui/SegmentedControl";
import { CloseIcon } from "../workbench/icons";

interface TerminalSettingsViewProps {
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
  appearanceTheme,
  settings,
  onChange,
  onOpenKeyboardShortcuts,
  onReset,
}: TerminalSettingsViewProps) {
  const previewTheme = resolveTerminalTheme(settings.colorScheme, appearanceTheme);

  return (
    <section className="settings-view" aria-label="终端设置">
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

            <SettingsGroup title="终端突显集">
              <HighlightSetsEditor
                activeSetId={settings.activeHighlightSetId}
                onChange={onChange}
                sets={settings.highlightSets}
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

function HighlightSetsEditor({
  activeSetId,
  onChange,
  sets,
}: {
  activeSetId: string | null;
  onChange: (settings: Partial<TerminalSettings>) => void;
  sets: TerminalHighlightSet[];
}) {
  const [expandedSetIds, setExpandedSetIds] = useState<ReadonlySet<string>>(() => new Set());

  const updateSet = (setId: string, patch: Partial<TerminalHighlightSet>) => {
    onChange({
      highlightSets: sets.map((set) => set.id === setId ? { ...set, ...patch } : set),
    });
  };

  const addSet = () => {
    const id = crypto.randomUUID();
    const highlightSet: TerminalHighlightSet = {
      id,
      name: `突显集 ${sets.length + 1}`,
      enabled: true,
      rules: [],
    };
    onChange({
      activeHighlightSetId: id,
      highlightSets: [...sets, highlightSet],
    });
    setExpandedSetIds((current) => new Set(current).add(id));
  };

  const toggleSet = (setId: string) => {
    setExpandedSetIds((current) => {
      const next = new Set(current);
      if (next.has(setId)) next.delete(setId);
      else next.add(setId);
      return next;
    });
  };

  const removeSet = (setId: string) => {
    const remainingSets = sets.filter((set) => set.id !== setId);
    onChange({
      activeHighlightSetId: activeSetId === setId
        ? remainingSets.find((set) => set.enabled)?.id ?? null
        : activeSetId,
      highlightSets: remainingSets,
    });
    setExpandedSetIds((current) => {
      const next = new Set(current);
      next.delete(setId);
      return next;
    });
  };

  const toggleSetEnabled = (setId: string) => {
    const target = sets.find((set) => set.id === setId);
    if (!target) return;
    const enabled = !target.enabled;
    const highlightSets = sets.map((set) => set.id === setId ? { ...set, enabled } : set);
    const activeHighlightSetId = enabled
      ? activeSetId ?? setId
      : activeSetId === setId
        ? highlightSets.find((set) => set.enabled)?.id ?? null
        : activeSetId;
    onChange({ activeHighlightSetId, highlightSets });
  };

  return (
    <div className="highlight-rules-editor">
      <div className="highlight-rules-intro">
        <div>
          <strong>按场景组织颜色规则</strong>
          <small>先启用需要的突显集，再选择其中一套作为当前终端规则。所有集默认折叠。</small>
        </div>
        <button className="highlight-add-button" onClick={addSet} type="button">新建突显集</button>
      </div>

      {sets.length === 0 ? (
        <div className="highlight-empty">尚未创建突显集。为防火墙、日志或不同设备创建一套独立规则。</div>
      ) : (
        <div className="highlight-set-list">
          {sets.map((set, index) => {
            const expanded = expandedSetIds.has(set.id);
            const active = set.id === activeSetId;
            return (
              <section
                className="highlight-set"
                data-active={active}
                data-expanded={expanded}
                key={set.id}
              >
                <header>
                  <button
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "折叠" : "展开"}${set.name}`}
                    className="highlight-set-disclosure"
                    onClick={() => toggleSet(set.id)}
                    type="button"
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m5.5 6.5 2.5 2.5 2.5-2.5" /></svg>
                    <span className="highlight-set-file" aria-hidden="true">
                      <svg viewBox="0 0 18 18"><path d="M4.5 2.75h5.2l3.8 3.8v8.7H4.5z" /><path d="M9.5 2.75v4h4" /></svg>
                    </span>
                    <span>
                      <strong>{set.name || `突显集 ${index + 1}`}</strong>
                      <small>{set.rules.length} 条规则</small>
                    </span>
                    <span className="highlight-set-palette" aria-hidden="true">
                      {set.rules.filter((rule) => rule.enabled && isValidHexColor(rule.color)).slice(0, 4).map((rule) => (
                        <i key={rule.id} style={{ background: rule.color }} />
                      ))}
                    </span>
                  </button>
                  <button
                    aria-checked={set.enabled}
                    aria-label={`${set.enabled ? "停用" : "启用"}${set.name}`}
                    className="switch compact-switch highlight-set-enable"
                    data-active={set.enabled}
                    onClick={() => toggleSetEnabled(set.id)}
                    role="switch"
                    type="button"
                  ><span /></button>
                  <button
                    aria-pressed={active}
                    className="highlight-set-use-button"
                    data-active={active}
                    disabled={!set.enabled}
                    onClick={() => onChange({ activeHighlightSetId: set.id })}
                    type="button"
                  >{active ? "使用中" : "使用"}</button>
                </header>
                <div aria-hidden={!expanded} className="highlight-set-body" data-expanded={expanded} inert={!expanded}>
                  <div className="highlight-set-content">
                    <div className="highlight-set-toolbar">
                      <label>
                        <span>突显集名称</span>
                        <input
                          className="settings-text-input"
                          onBlur={(event) => updateSet(set.id, { name: event.target.value.trim() || `突显集 ${index + 1}` })}
                          onChange={(event) => updateSet(set.id, { name: event.target.value })}
                          value={set.name}
                        />
                      </label>
                      <button className="highlight-add-rule-button" onClick={() => updateSet(set.id, { rules: [...set.rules, createHighlightRule()] })} type="button">添加规则</button>
                      <button aria-label={`删除${set.name}`} className="highlight-delete-set-button" onClick={() => removeSet(set.id)} type="button"><CloseIcon />删除突显集</button>
                    </div>
                    {set.rules.length === 0 ? (
                      <div className="highlight-set-empty">这个突显集还没有规则</div>
                    ) : (
                      <div className="highlight-rule-list">
                        {set.rules.map((rule, ruleIndex) => (
                          <HighlightRuleEditor
                            index={ruleIndex}
                            key={rule.id}
                            onChange={(patch) => updateSet(set.id, {
                              rules: set.rules.map((item) => item.id === rule.id ? { ...item, ...patch } : item),
                            })}
                            onRemove={() => updateSet(set.id, { rules: set.rules.filter((item) => item.id !== rule.id) })}
                            rule={rule}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HighlightRuleEditor({
  index,
  onChange,
  onRemove,
  rule,
}: {
  index: number;
  onChange: (patch: Partial<TerminalHighlightRule>) => void;
  onRemove: () => void;
  rule: TerminalHighlightRule;
}) {
  const regexValid = rule.matchMode !== "regex" || isValidRegex(rule.pattern);
  const colorValid = isValidHexColor(rule.color);
  return (
    <section className="highlight-rule" data-enabled={rule.enabled}>
      <header>
        <span className="highlight-rule-color" style={{ background: colorValid ? rule.color : "transparent" }} />
        <span className="highlight-rule-title"><strong>规则 {index + 1}</strong><small>{rule.pattern || "尚未设置匹配内容"}</small></span>
        <span className="highlight-rule-spacer" />
        <button aria-checked={rule.enabled} aria-label={`启用规则 ${index + 1}`} className="switch compact-switch" data-active={rule.enabled}
          onClick={() => onChange({ enabled: !rule.enabled })} role="switch" type="button"><span /></button>
        <button aria-label={`删除规则 ${index + 1}`} className="highlight-remove-button" onClick={onRemove} type="button"><CloseIcon /></button>
      </header>
      <div className="highlight-rule-grid">
        <label className="highlight-match-mode">
          <span>匹配方式</span>
          <SegmentedControl compact items={[{ value: "text", label: "文本" }, { value: "regex", label: "正则" }] as const}
            onChange={(matchMode) => onChange({ matchMode })} value={rule.matchMode} />
        </label>
        <label className="highlight-pattern-field">
          <span>{rule.matchMode === "text" ? "匹配文本" : "正则表达式"}</span>
          <input aria-invalid={!regexValid} className="settings-text-input" onChange={(event) => onChange({ pattern: event.target.value })}
            placeholder={rule.matchMode === "text" ? "例如 ERROR" : "例如 ERROR|FAILED"} spellCheck={false} value={rule.pattern} />
          {!regexValid && <small className="field-error">正则表达式格式无效</small>}
        </label>
        <label className="highlight-color-field">
          <span>文字颜色</span>
          <div className="highlight-color-control" data-invalid={!colorValid}>
            <input aria-label="十六进制颜色" maxLength={7} onChange={(event) => onChange({ color: event.target.value.toUpperCase() })}
              placeholder="#FFFFFF" spellCheck={false} type="text" value={rule.color} />
            <input aria-label="打开调色盘" onChange={(event) => onChange({ color: event.target.value.toUpperCase() })}
              type="color" value={colorValid ? rule.color : "#FFFFFF"} />
          </div>
          {!colorValid && <small className="field-error">请输入六位十六进制颜色</small>}
        </label>
        <label className="highlight-case-option">
          <input checked={rule.caseSensitive} onChange={(event) => onChange({ caseSensitive: event.target.checked })} type="checkbox" />
          <span>区分大小写</span>
        </label>
      </div>
    </section>
  );
}

function createHighlightRule(): TerminalHighlightRule {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    matchMode: "text",
    pattern: "",
    color: "#FFB86C",
    caseSensitive: false,
  };
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
