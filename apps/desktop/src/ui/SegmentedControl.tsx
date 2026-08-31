import type { CSSProperties } from "react";

interface SegmentedControlProps<T extends string | number> {
  ariaLabel?: string;
  compact?: boolean;
  items: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  value: T;
}

export function SegmentedControl<T extends string | number>({
  ariaLabel,
  compact = false,
  items,
  onChange,
  value,
}: SegmentedControlProps<T>) {
  const activeIndex = Math.max(0, items.findIndex((item) => item.value === value));
  const style = {
    "--segment-count": items.length,
    "--segment-index": activeIndex,
  } as CSSProperties;

  return (
    <div
      aria-label={ariaLabel}
      className={`segmented-control${compact ? " compact-segmented-control" : ""}`}
      role="group"
      style={style}
    >
      <span aria-hidden="true" className="segmented-control-indicator" />
      {items.map((item) => (
        <button
          aria-pressed={item.value === value}
          data-active={item.value === value}
          key={item.value}
          onClick={() => onChange(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
