import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronIcon } from "../workbench/icons";
import { useFloatingMenu } from "./useFloatingMenu";

export interface MultiSelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface MultiSelectProps<T extends string> {
  ariaLabel: string;
  className?: string;
  emptyLabel?: string;
  options: readonly MultiSelectOption<T>[];
  onChange: (values: T[]) => void;
  placeholder?: string;
  selectedLabel?: string;
  values: readonly T[];
}

/** Small app-owned multi-select used where a single native select cannot express the model. */
export function MultiSelect<T extends string>({
  ariaLabel,
  className,
  emptyLabel = "暂无可选项",
  onChange,
  options,
  placeholder = "请选择",
  selectedLabel,
  values,
}: MultiSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useFloatingMenu(open, triggerRef);
  const selected = useMemo(() => new Set(values), [values]);
  const label = selectedLabel ?? (values.length === 0
    ? placeholder
    : values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(" · "));

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  const toggle = (option: MultiSelectOption<T>) => {
    if (option.disabled) return;
    const next = selected.has(option.value)
      ? values.filter((value) => value !== option.value)
      : [...values, option.value];
    onChange(next);
  };

  return (
    <div className={["select-root", "multi-select-root", className].filter(Boolean).join(" ")} data-open={open} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="select-trigger multi-select-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span className="select-trigger-label">{label}</span>
        <span aria-hidden="true" className="select-chevron"><ChevronIcon /></span>
      </button>
      {open && createPortal(
        <div className="select-menu multi-select-menu select-menu-portal" ref={menuRef} style={menuStyle}>
          <div aria-label={ariaLabel} aria-multiselectable="true" className="select-options" role="listbox">
            {options.length > 0 ? options.map((option) => (
              <button
                aria-selected={selected.has(option.value)}
                className="select-option multi-select-option"
                disabled={option.disabled}
                key={option.value}
                onClick={() => toggle(option)}
                role="option"
                type="button"
              >
                {option.icon && <span aria-hidden="true" className="select-option-leading">{option.icon}</span>}
                <span className="select-option-copy">
                  <span className="select-option-label">{option.label}</span>
                  {option.description && <span className="select-option-description">{option.description}</span>}
                </span>
                <span aria-hidden="true" className="multi-select-check">{selected.has(option.value) && <CheckIcon />}</span>
              </button>
            )) : <div className="select-empty">{emptyLabel}</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
