import { useEffect, useMemo, useState } from "react";
import type { SavedConnectionSession } from "../connections/types";
import { CloseIcon, ConnectionProtocolIcon, EditIcon, PlusIcon } from "../workbench/icons";
import type { Project, ProjectContext, ProjectContextPatch } from "./types";

interface ProjectSidebarProps {
  projects: readonly Project[];
  activeProjectId: string;
  connections: readonly SavedConnectionSession[];
  onCreateProject: (name: string) => void;
  onActivateProject: (projectId: string) => void;
  onAddDevice: (projectId: string, connectionId: string) => void;
  onRemoveDevice: (projectId: string, connectionId: string) => void;
  onUpdateContext: (projectId: string, patch: ProjectContextPatch) => void;
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  connections,
  onCreateProject,
  onActivateProject,
  onAddDevice,
  onRemoveDevice,
  onUpdateContext,
}: ProjectSidebarProps) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(activeProject?.id ?? null);
  const [editingContext, setEditingContext] = useState(false);
  const [deviceToAdd, setDeviceToAdd] = useState("");

  useEffect(() => {
    if (!activeProject) return;
    setExpandedProjectId(activeProject.id);
    setEditingContext(false);
    setDeviceToAdd("");
  }, [activeProject?.id]);

  if (!activeProject) return null;

  const submitProject = () => {
    const name = newName.trim();
    if (!name) return;
    onCreateProject(name);
    setNewName("");
    setCreating(false);
  };

  return (
    <div className="project-sidebar" aria-label="项目列表">
      <div className="project-sidebar-toolbar">
        <div>
          <span className="project-sidebar-kicker">PROJECTS</span>
          <span className="project-sidebar-title">工作区</span>
        </div>
        <button
          aria-label="新建项目"
          className="project-add-button"
          onClick={() => setCreating((value) => !value)}
          title="新建项目"
          type="button"
        >
          <PlusIcon />
        </button>
      </div>

      {creating && (
        <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); submitProject(); }}>
          <input
            autoFocus
            aria-label="项目名称"
            onChange={(event) => setNewName(event.target.value)}
            placeholder="项目名称"
            value={newName}
          />
          <div>
            <button className="project-form-secondary" onClick={() => { setCreating(false); setNewName(""); }} type="button">取消</button>
            <button className="project-form-primary" disabled={!newName.trim()} type="submit">创建</button>
          </div>
        </form>
      )}

      <div className="project-list">
        <div className="project-list-label">当前项目</div>
        <ProjectListItem
          active
          expanded={expandedProjectId === activeProject.id}
          onClick={() => {
            onActivateProject(activeProject.id);
            setExpandedProjectId((current) => current === activeProject.id ? null : activeProject.id);
          }}
          project={activeProject}
        />
        {projects.filter((project) => project.id !== activeProject.id).length > 0 && <div className="project-list-label project-list-label-secondary">项目</div>}
        {projects.filter((project) => project.id !== activeProject.id).map((project) => (
          <ProjectListItem
            expanded={expandedProjectId === project.id}
            key={project.id}
            onClick={() => {
              onActivateProject(project.id);
              setExpandedProjectId(project.id);
            }}
            project={project}
          />
        ))}
      </div>

      {expandedProjectId === activeProject.id && (
        <ProjectDetails
          connections={connections}
          deviceToAdd={deviceToAdd}
          editingContext={editingContext}
          onAddDevice={() => {
            if (!deviceToAdd) return;
            onAddDevice(activeProject.id, deviceToAdd);
            setDeviceToAdd("");
          }}
          onChangeDeviceToAdd={setDeviceToAdd}
          onRemoveDevice={(connectionId) => onRemoveDevice(activeProject.id, connectionId)}
          onCancelContextEdit={() => setEditingContext(false)}
          onStartEditContext={() => setEditingContext(true)}
          onUpdateContext={(patch) => {
            onUpdateContext(activeProject.id, patch);
            setEditingContext(false);
          }}
          project={activeProject}
        />
      )}
    </div>
  );
}

function ProjectListItem({
  active = false,
  expanded,
  onClick,
  project,
}: {
  active?: boolean;
  expanded: boolean;
  onClick: () => void;
  project: Project;
}) {
  return (
    <button className="project-list-item" data-active={active} data-expanded={expanded} onClick={onClick} type="button">
      <span className="project-list-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
      <span className="project-list-copy">
        <strong>{project.name}</strong>
        <small>{project.devices.length} 台设备 · {project.sessions.length} 个会话</small>
      </span>
    </button>
  );
}

function ProjectDetails({
  connections,
  deviceToAdd,
  editingContext,
  onAddDevice,
  onChangeDeviceToAdd,
  onRemoveDevice,
  onCancelContextEdit,
  onStartEditContext,
  onUpdateContext,
  project,
}: {
  connections: readonly SavedConnectionSession[];
  deviceToAdd: string;
  editingContext: boolean;
  onAddDevice: () => void;
  onChangeDeviceToAdd: (value: string) => void;
  onRemoveDevice: (connectionId: string) => void;
  onCancelContextEdit: () => void;
  onStartEditContext: () => void;
  onUpdateContext: (patch: ProjectContextPatch) => void;
  project: Project;
}) {
  const linkedIds = new Set(project.devices.map((device) => device.connectionId));
  const linkedConnections = project.devices.map((device) => ({
    ref: device,
    session: connections.find((connection) => connection.id === device.connectionId),
  }));
  const availableConnections = connections.filter((connection) => !linkedIds.has(connection.id));

  return (
    <section className="project-details" aria-label={`${project.name} 项目详情`}>
      <div className="project-detail-section">
        <div className="project-detail-heading"><span>设备</span><span>{project.devices.length}</span></div>
        <div className="project-device-list">
          {linkedConnections.map(({ ref, session }) => (
            <div className="project-device-row" key={ref.connectionId}>
              <span className="project-device-icon">{session ? <ConnectionProtocolIcon kind={connectionKind(session)} /> : "?"}</span>
              <span>{ref.alias || session?.name || "已移除的连接"}</span>
              <button aria-label={`移除 ${ref.alias || session?.name || "设备"}`} onClick={() => onRemoveDevice(ref.connectionId)} type="button"><CloseIcon /></button>
            </div>
          ))}
          {linkedConnections.length === 0 && <p className="project-detail-empty">尚未添加设备</p>}
        </div>
        <div className="project-device-add">
          <select aria-label="选择设备" onChange={(event) => onChangeDeviceToAdd(event.target.value)} value={deviceToAdd}>
            <option value="">选择已保存设备</option>
            {availableConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
          <button aria-label="添加设备" disabled={!deviceToAdd} onClick={onAddDevice} title="添加设备" type="button"><PlusIcon /></button>
        </div>
      </div>

      <div className="project-detail-section project-context-section">
        <div className="project-detail-heading"><span>项目上下文</span><button aria-label="编辑项目上下文" onClick={onStartEditContext} title="编辑项目上下文" type="button"><EditIcon /></button></div>
        {editingContext ? <ProjectContextEditor context={project.context} onCancel={onCancelContextEdit} onSave={onUpdateContext} /> : <ProjectContextSummary context={project.context} />}
      </div>
    </section>
  );
}

function ProjectContextSummary({ context }: { context: ProjectContext }) {
  const summary = context.goal || context.confirmedFacts[0] || "还没有记录项目目标";
  return (
    <div className="project-context-summary">
      <p>{summary}</p>
      <span>更新于 {formatDate(context.updatedAt)}</span>
      {context.nextSteps.length > 0 && <small>下一步：{context.nextSteps[0]}</small>}
    </div>
  );
}

function ProjectContextEditor({
  context,
  onCancel,
  onSave,
}: {
  context: ProjectContext;
  onCancel: () => void;
  onSave: (patch: ProjectContextPatch) => void;
}) {
  const [draft, setDraft] = useState(() => contextDraft(context));
  const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <div className="project-context-editor">
      <label>目标<input onChange={(event) => update("goal", event.target.value)} value={draft.goal} /></label>
      <label>拓扑<textarea onChange={(event) => update("topology", event.target.value)} rows={2} value={draft.topology} /></label>
      <label>关键配置<textarea onChange={(event) => update("keyConfigurations", event.target.value)} rows={2} value={draft.keyConfigurations} /></label>
      <label>已确认事实<textarea onChange={(event) => update("confirmedFacts", event.target.value)} rows={2} value={draft.confirmedFacts} /></label>
      <label>测试进度<textarea onChange={(event) => update("progress", event.target.value)} rows={2} value={draft.progress} /></label>
      <label>问题<textarea onChange={(event) => update("issues", event.target.value)} rows={2} value={draft.issues} /></label>
      <label>重要结论<textarea onChange={(event) => update("conclusions", event.target.value)} rows={2} value={draft.conclusions} /></label>
      <label>下一步<textarea onChange={(event) => update("nextSteps", event.target.value)} rows={2} value={draft.nextSteps} /></label>
      <div className="project-context-actions">
        <button className="project-form-secondary" onClick={onCancel} type="button">取消</button>
        <button className="project-form-primary" onClick={() => onSave({ goal: draft.goal.trim(), topology: draft.topology.trim(), keyConfigurations: lines(draft.keyConfigurations), confirmedFacts: lines(draft.confirmedFacts), progress: draft.progress.trim(), issues: lines(draft.issues), conclusions: lines(draft.conclusions), nextSteps: lines(draft.nextSteps) })} type="button">保存</button>
      </div>
    </div>
  );
}

function contextDraft(context: ProjectContext) {
  return {
    goal: context.goal,
    topology: context.topology,
    keyConfigurations: context.keyConfigurations.join("\n"),
    confirmedFacts: context.confirmedFacts.join("\n"),
    progress: context.progress,
    issues: context.issues.join("\n"),
    conclusions: context.conclusions.join("\n"),
    nextSteps: context.nextSteps.join("\n"),
  };
}

function lines(value: string) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function connectionKind(session: SavedConnectionSession): "ssh" | "telnet" | "serial" | "rdp" {
  return session.kind;
}

function formatDate(value: number) {
  if (!value) return "尚未更新";
  return new Date(value).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
