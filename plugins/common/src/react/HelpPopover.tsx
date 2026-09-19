import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cx } from "./cx";

export interface HelpPopoverProps {
  children: ReactNode;
  label?: string;
  className?: string;
  panelClassName?: string;
}

export function HelpPopover({
  children,
  label = "显示说明",
  className,
  panelClassName,
}: HelpPopoverProps) {
  const generatedId = useId().replace(/:/g, "");
  const panelId = `fh-help-${generatedId}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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

  return (
    <span
      ref={rootRef}
      className={cx("fh-help relative inline-flex align-middle", className)}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setOpen(false);
      }}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="fh-help__trigger inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#3c5b49] bg-[#101f17] text-xs font-bold text-[#a9c0b2] transition-colors hover:border-[#79a087] hover:text-white motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b9f2ca] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09130e]"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        ?
      </button>
      {open ? (
        <span
          id={panelId}
          role="region"
          aria-label={label}
          className={cx(
            "fh-help__content absolute z-50 mt-9 w-[min(22rem,calc(100vw-2rem))] rounded-[10px] border border-[#355442] bg-[#0c1912] p-4 text-left text-sm leading-6 text-[#bed0c4] shadow-[0_18px_50px_rgba(0,0,0,0.46)]",
            panelClassName,
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
