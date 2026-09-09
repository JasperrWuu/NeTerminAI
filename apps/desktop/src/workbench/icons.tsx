import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconFrame({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      viewBox="0 0 24 24"
      width="18"
      {...props}
    >
      {children}
    </svg>
  );
}
export function ConnectionIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M7 8.5h10M9 5.5v3m6-3v3M8 8.5v3a4 4 0 0 0 4 4m4-7v3a4 4 0 0 1-4 4m0 0v3" />
    </IconFrame>
  );
}

export function SubnetIcon(props: IconProps) {
  return <IconFrame {...props}>
    <path d="M4 4v8M9 12V4h3a3 3 0 0 1 0 6H9M20 4l-3 8M3 17h18M3 16v4m6-4v4m6-4v4m6-4v4" />
  </IconFrame>;
}

export function SyslogIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M12 3v11m-4-4 4 4 4-4M8 17h8" /></IconFrame>;
}

export function DiagnosticTraceIcon(props: IconProps) {
  return <IconFrame {...props}>
    <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M8 7h8M8 17h8M6 12h3l2-3 2 6 2-3h3" />
  </IconFrame>;
}

export function WorkspaceIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect height="16" rx="2.5" width="17" x="3.5" y="4" />
      <path d="M9 4v16M9 10h11.5" />
    </IconFrame>
  );
}

export function ToolsIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3" y="7" width="18" height="13" rx="3" />
      <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M3 12h18M8 11v3m8-3v3" />
    </IconFrame>
  );
}

export function ConfigurationIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M8 8h8M8 12h8M8 16h8M10 6.5v3m4 1v3m-4 1v3" />
    </IconFrame>
  );
}

export function AutomationIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m5 7 4 5-4 5M11 17h8" />
      <path d="M17 4v3m-1.5-1.5h3M19 17v3m-1.5-1.5h3" />
    </IconFrame>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.2 2.8h-.4a1.8 1.8 0 0 0-1.8 1.8v.2a1.8 1.8 0 0 1-.9 1.5l-.4.2a1.8 1.8 0 0 1-1.8 0l-.2-.1a1.8 1.8 0 0 0-2.4.7l-.2.3a1.8 1.8 0 0 0 .6 2.4l.2.1a1.8 1.8 0 0 1 .9 1.6v.5a1.8 1.8 0 0 1-.9 1.6l-.2.1a1.8 1.8 0 0 0-.6 2.4l.2.3a1.8 1.8 0 0 0 2.4.7l.2-.1a1.8 1.8 0 0 1 1.8 0l.4.2a1.8 1.8 0 0 1 .9 1.5v.2a1.8 1.8 0 0 0 1.8 1.8h.4a1.8 1.8 0 0 0 1.8-1.8v-.2a1.8 1.8 0 0 1 .9-1.5l.4-.2a1.8 1.8 0 0 1 1.8 0l.2.1a1.8 1.8 0 0 0 2.4-.7l.2-.3a1.8 1.8 0 0 0-.6-2.4l-.2-.1a1.8 1.8 0 0 1-.9-1.6v-.5a1.8 1.8 0 0 1 .9-1.6l.2-.1a1.8 1.8 0 0 0 .6-2.4l-.2-.3a1.8 1.8 0 0 0-2.4-.7l-.2.1a1.8 1.8 0 0 1-1.8 0l-.4-.2a1.8 1.8 0 0 1-.9-1.5v-.2a1.8 1.8 0 0 0-1.8-1.8Z" />
    </IconFrame>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect height="13" rx="2" width="18" x="3" y="5.5" />
      <path d="M6 9h.01M9 9h.01M12 9h.01M15 9h.01M6 12h.01M9 12h6" />
    </IconFrame>
  );
}

export function SidebarIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect height="15" rx="2" width="18" x="3" y="4.5" />
      <path d="M8.5 4.5v15" />
    </IconFrame>
  );
}

export function AssistantIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M10 4c.8 4.6 2.4 6.2 7 7-4.6.8-6.2 2.4-7 7-.8-4.6-2.4-6.2-7-7 4.6-.8 6.2-2.4 7-7Z" />
      <path d="M18.5 3v5M16 5.5h5M18.5 16v4M16.5 18h4" />
    </IconFrame>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </IconFrame>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M20 15.2A8 8 0 0 1 8.8 4a8 8 0 1 0 11.2 11.2Z" />
    </IconFrame>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="currentColor" fillOpacity=".12" />
      <path d="M3 10h18" opacity=".6" />
    </IconFrame>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m9 7 5 5-5 5" />
    </IconFrame>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconFrame>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m8 5 9 7-9 7V5Z" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m5 12 4 4 10-10" />
    </IconFrame>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m14.5 5.5 4 4M5 19l1-4 9-9a2.12 2.12 0 0 1 3 3l-9 9-4 1Z" />
    </IconFrame>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m7 7 10 10M17 7 7 17" />
    </IconFrame>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5 7h14M10 4h4l1 3H9l1-3ZM7 7l.8 13h8.4L17 7M10 10v6M14 10v6" />
    </IconFrame>
  );
}

/** Shared visual vocabulary for connection rows, launchers and session tabs. */
export function ConnectionProtocolIcon({ kind, ...props }: IconProps & {
  kind: "localTerminal" | "ssh" | "telnet" | "serial" | "rdp";
}) {
  return (
    <IconFrame {...props}>
      {kind === "rdp" ? (
        <><rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M8 21h8M12 17v4" /></>
      ) : kind === "serial" ? (
        <><path d="M7 8h10v4a5 5 0 0 1-10 0V8ZM9 4v4m6-4v4M12 17v4" /><path d="M10 11h4" /></>
      ) : kind === "telnet" ? (
        <><rect x="8" y="3" width="8" height="6" rx="1.5" /><path d="M12 9v5M5 17v-3h14v3" /><rect x="2" y="17" width="6" height="4" rx="1" /><rect x="16" y="17" width="6" height="4" rx="1" /></>
      ) : kind === "ssh" ? (
        <><path d="m4 8 4 4-4 4M10 16h4" /><rect x="15" y="5" width="6" height="6" rx="1.5" /><path d="M16.5 5V3.5a1.5 1.5 0 0 1 3 0V5" /></>
      ) : (
        <><path d="m5 7 5 5-5 5M13 17h6" /></>
      )}
    </IconFrame>
  );
}
