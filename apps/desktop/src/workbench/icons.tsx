import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconFrame({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
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
      <path d="M14.7 5.2a4.4 4.4 0 0 0-5.2 5.6L4.8 15.5a2 2 0 1 0 2.8 2.8l4.7-4.7a4.4 4.4 0 0 0 5.6-5.2l-2.7 2.7-2.4-.6-.7-2.5 2.6-2.8Z" />
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
      <path d="M12 3.5 13.6 8l4.4 1.6-4.4 1.6L12 15.5l-1.6-4.3L6 9.6 10.4 8 12 3.5Z" />
      <path d="m18.5 15 .7 2 .8.3-.8.3-.7 1.9-.7-1.9-.8-.3.8-.3.7-2Z" />
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
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.7 2h8.6a1 1 0 0 1 1 1v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
      <path d="M4 9h16" opacity=".55" />
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
