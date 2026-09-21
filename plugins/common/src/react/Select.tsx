import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { cx } from "./cx";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
}

function firstEnabledIndex(options: SelectOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex(options: SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function nextEnabledIndex(
  options: SelectOption[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (!options.length) return -1;

  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (currentIndex + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }

  return -1;
}

export function Select({
  options,
  value,
  onChange,
  id,
  name,
  placeholder = "请选择",
  ariaLabel,
  ariaDescribedBy,
  "aria-label": ariaLabelAttribute,
  "aria-describedby": ariaDescribedByAttribute,
  disabled = false,
  required = false,
  className,
  triggerClassName,
  menuClassName,
}: SelectProps) {
  const generatedId = useId().replace(/:/g, "");
  const selectId = id ?? `fh-select-${generatedId}`;
  const listboxId = `${selectId}-listbox`;
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [activeIndex, setActiveIndex] = useState(
    selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options),
  );
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const resolvedAriaLabel = ariaLabelAttribute ?? ariaLabel;
  const resolvedAriaDescribedBy = ariaDescribedByAttribute ?? ariaDescribedBy;
  const activeOptionId =
    activeIndex >= 0 ? `${selectId}-option-${activeIndex}` : undefined;

  const enabledOptionCount = useMemo(
    () => options.reduce((count, option) => count + (option.disabled ? 0 : 1), 0),
    [options],
  );

  useEffect(() => {
    if (open) window.requestAnimationFrame(() => menuRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  function openMenu(preferredIndex?: number): void {
    if (disabled || enabledOptionCount === 0) return;
    const nextIndex =
      preferredIndex ??
      (selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : firstEnabledIndex(options));
    setActiveIndex(nextIndex);
    setOpen(true);
  }

  function commit(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(selectedIndex >= 0 ? selectedIndex : lastEnabledIndex(options));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLUListElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        nextEnabledIndex(options, current, event.key === "ArrowDown" ? 1 : -1),
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options));
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(lastEnabledIndex(options));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div
      ref={shellRef}
      className={cx("fh-select relative min-w-0", className)}
      data-open={open || undefined}
    >
      {name ? (
        <input type="hidden" name={name} value={value} disabled={disabled} />
      ) : null}
      <button
        ref={triggerRef}
        id={selectId}
        type="button"
        className={cx(
          "fh-select__trigger flex min-h-11 w-full items-center justify-between gap-3 rounded-[10px] border border-[var(--fh-border,#304b3c)] bg-[var(--fh-canvas,#0b1711)] px-3.5 text-left text-sm text-[var(--fh-text,#e5f0e9)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-[border-color,background-color,box-shadow] hover:border-[var(--fh-border,#557462)] hover:bg-[var(--fh-canvas,#0e1c15)] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)] disabled:cursor-not-allowed disabled:opacity-45",
          triggerClassName,
        )}
        aria-label={resolvedAriaLabel}
        aria-describedby={resolvedAriaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={cx("truncate", !selectedOption && "text-[var(--fh-muted,#70877a)]")}>
          {selectedOption?.label ?? placeholder}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 8"
          className={cx(
            "h-2 w-3 shrink-0 text-[var(--fh-muted,#8eaa99)] transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
          fill="none"
        >
          <path d="m1 1 5 5 5-5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open ? (
        <ul
          ref={menuRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-label={resolvedAriaLabel ?? "可选项"}
          aria-activedescendant={activeOptionId}
          className={cx(
            "fh-select__menu absolute z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-[10px] border border-[var(--fh-border,#355442)] bg-[var(--fh-canvas,#0b1711)] p-1.5 text-sm text-[var(--fh-text,#dce9e0)] shadow-[0_18px_50px_rgba(0,0,0,0.42)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)]",
            menuClassName,
          )}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${selectId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={cx(
                "fh-select__option flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-[7px] px-3 py-2 outline-none",
                index === activeIndex && !option.disabled && "bg-[var(--fh-surface,#1a3024)] text-[var(--fh-text,#ffffff)]",
                option.value === value && "font-semibold text-[var(--fh-accent,#b9efc9)]",
                option.disabled
                  ? "cursor-not-allowed text-[var(--fh-muted,#52685b)]"
                  : "hover:bg-[var(--fh-surface,#16291f)]",
              )}
              onMouseEnter={() => {
                if (!option.disabled) setActiveIndex(index);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(index)}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value ? (
                <span aria-hidden="true" className="text-[var(--fh-accent,#a9e8bc)]">
                  ●
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
