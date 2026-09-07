import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatingMenu } from "./useFloatingMenu";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  style?: CSSProperties;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  emptyLabel?: string;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  placeholderIcon?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  value: T;
}

/**
 * Small, app-owned select primitive.  The menu is positioned against this
 * root, so the trigger and panel always share the same inline edges.
 */
export function Select<T extends string>({
  ariaLabel,
  className,
  disabled = false,
  emptyLabel = "暂无可选项",
  onChange,
  options,
  placeholder = "请选择",
  placeholderIcon,
  searchable = false,
  searchPlaceholder = "搜索",
  value,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const menuStyle = useFloatingMenu(open, triggerRef);

  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    const selectedIndex = filteredOptions.findIndex((option) => option.value === value);
    setActiveIndex(Math.max(0, selectedIndex));
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [filteredOptions, open, value]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  const selectOption = (option: SelectOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const moveActive = (delta: number) => {
    if (filteredOptions.length === 0) return;
    setActiveIndex((current) => (current + delta + filteredOptions.length) % filteredOptions.length);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(-1);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) selectOption(option);
    }
  };

  const triggerLabel = selectedOption?.label ?? placeholder;
  const leading = selectedOption?.icon ?? placeholderIcon;
  const rootClassName = ["select-root", className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName} data-disabled={disabled} data-open={open} ref={rootRef}>
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="select-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className="select-trigger-main">
          {leading && <span className="select-leading" aria-hidden="true">{leading}</span>}
          <span className="select-trigger-label" style={selectedOption?.style}>{triggerLabel}</span>
        </span>
        <span aria-hidden="true" className="select-chevron"><svg viewBox="0 0 16 16"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></span>
      </button>

      {open && createPortal(
        <div className="select-menu select-menu-portal" ref={menuRef} style={menuStyle}>
          {searchable && (
            <input
              aria-label={`搜索${ariaLabel}`}
              autoComplete="off"
              className="select-search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  triggerRef.current?.focus();
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveActive(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const option = filteredOptions[activeIndex];
                  if (option) selectOption(option);
                }
              }}
              placeholder={searchPlaceholder}
              ref={searchRef}
              spellCheck={false}
              value={query}
            />
          )}
          <div aria-label={ariaLabel} className="select-options" id={listId} role="listbox">
            {filteredOptions.length > 0 ? filteredOptions.map((option, index) => (
              <button
                aria-selected={option.value === value}
                className="select-option"
                data-active={activeIndex === index}
                disabled={option.disabled}
                key={option.value}
                onClick={() => selectOption(option)}
                onPointerEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                {option.icon && <span aria-hidden="true" className="select-option-leading">{option.icon}</span>}
                <span className="select-option-copy">
                  <span className="select-option-label" style={option.style}>{option.label}</span>
                  {option.description && <span className="select-option-description">{option.description}</span>}
                </span>
                <span aria-hidden="true" className="select-option-check">{option.value === value ? "✓" : ""}</span>
              </button>
            )) : <div className="select-empty">{emptyLabel}</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
