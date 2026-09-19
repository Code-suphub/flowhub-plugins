import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { SelectOption } from "./Select";
import { cx } from "./cx";

export type ComboboxOption = SelectOption;

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  inputClassName?: string;
  menuClassName?: string;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function Combobox({
  options,
  value,
  onChange,
  id,
  name,
  placeholder = "输入或选择",
  emptyMessage = "没有匹配项",
  ariaLabel,
  ariaDescribedBy,
  "aria-label": ariaLabelAttribute,
  "aria-describedby": ariaDescribedByAttribute,
  disabled = false,
  required = false,
  className,
  inputClassName,
  menuClassName,
}: ComboboxProps) {
  const generatedId = useId().replace(/:/g, "");
  const comboboxId = id ?? `fh-combobox-${generatedId}`;
  const listboxId = `${comboboxId}-listbox`;
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedOption = options.find((option) => option.value === value);
  const resolvedAriaLabel = ariaLabelAttribute ?? ariaLabel;
  const resolvedAriaDescribedBy = ariaDescribedByAttribute ?? ariaDescribedBy;

  const filteredOptions = useMemo(() => {
    const keyword = normalize(query);
    if (!keyword) return options;
    return options.filter((option) => normalize(option.label).includes(keyword));
  }, [options, query]);

  const activeOption = filteredOptions[activeIndex];
  const activeOptionId = open && activeOption
    ? `${comboboxId}-option-${activeIndex}`
    : undefined;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (shellRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setQuery("");
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex(filteredOptions.findIndex((option) => !option.disabled));
  }, [filteredOptions]);

  function openMenu(): void {
    if (disabled || !options.length) return;
    setOpen(true);
  }

  function closeMenu(): void {
    setOpen(false);
    setQuery("");
  }

  function commit(option: ComboboxOption | undefined): void {
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function moveActive(direction: 1 | -1): void {
    if (!filteredOptions.length) return;
    setActiveIndex((current) => {
      const origin = current >= 0 ? current : (direction === 1 ? -1 : 0);
      for (let offset = 1; offset <= filteredOptions.length; offset += 1) {
        const index = (origin + direction * offset + filteredOptions.length) % filteredOptions.length;
        if (!filteredOptions[index]?.disabled) return index;
      }
      return current;
    });
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>): void {
    setQuery(event.target.value);
    setOpen(true);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      commit(activeOption);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      closeMenu();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  }

  return (
    <div ref={shellRef} className={cx("fh-combobox relative min-w-0", className)} data-open={open || undefined}>
      {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
      <div className="fh-combobox__control flex min-h-11 min-w-0 items-center overflow-hidden rounded-[10px] border border-[#304b3c] bg-[#0b1711] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-[border-color,background-color,box-shadow] hover:border-[#557462] hover:bg-[#0e1c15] focus-within:border-[#a9e8bc] focus-within:ring-1 focus-within:ring-[#b9f2ca] motion-reduce:transition-none">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="ml-3 h-4 w-4 shrink-0 text-[#6f8979]" fill="none">
          <circle cx="8.5" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.6" />
          <path d="m12.3 12.3 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </svg>
        <input
          ref={inputRef}
          id={comboboxId}
          role="combobox"
          type="text"
          autoComplete="off"
          className={cx("fh-combobox__input min-h-10 min-w-0 flex-1 !rounded-none !border-0 !bg-transparent px-2.5 text-sm text-[#e5f0e9] !shadow-none !outline-none placeholder:text-[#70877a] disabled:cursor-not-allowed", inputClassName)}
          value={open ? query : (selectedOption?.label ?? "")}
          placeholder={placeholder}
          aria-label={resolvedAriaLabel}
          aria-describedby={resolvedAriaDescribedBy}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={activeOptionId}
          aria-required={required || undefined}
          disabled={disabled}
          onFocus={openMenu}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          tabIndex={-1}
          className="fh-combobox__toggle grid min-h-10 w-10 shrink-0 place-items-center !border-0 !bg-transparent text-[#8eaa99] !shadow-none hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
          aria-label={open ? "收起选项" : "展开选项"}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) closeMenu();
            else {
              openMenu();
              inputRef.current?.focus();
            }
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 12 8" className={cx("h-2 w-3 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} fill="none">
            <path d="m1 1 5 5 5-5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>

      {open ? (
        <ul id={listboxId} role="listbox" aria-label={resolvedAriaLabel ?? "可选项"} className={cx("fh-combobox__menu absolute z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-[10px] border border-[#355442] bg-[#0b1711] p-1.5 text-sm text-[#dce9e0] shadow-[0_18px_50px_rgba(0,0,0,0.42)]", menuClassName)}>
          {filteredOptions.length ? filteredOptions.map((option, index) => (
            <li
              key={option.value}
              id={`${comboboxId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={cx(
                "fh-combobox__option flex min-h-10 cursor-pointer items-center rounded-[7px] px-3 py-2 outline-none",
                index === activeIndex && !option.disabled && "bg-[#1a3024] text-white",
                option.value === value && "font-semibold text-[#b9efc9]",
                option.disabled ? "cursor-not-allowed text-[#52685b]" : "hover:bg-[#16291f]",
              )}
              onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option)}
            >
              <span className="truncate">{option.label}</span>
            </li>
          )) : <li className="px-3 py-3 text-[#70877a]" role="presentation">{emptyMessage}</li>}
        </ul>
      ) : null}
    </div>
  );
}
