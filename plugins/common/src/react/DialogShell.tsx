import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type DialogHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import { cx } from "./cx";

export interface DialogShellProps
  extends Omit<DialogHTMLAttributes<HTMLDialogElement>, "children" | "title" | "open"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  closeLabel?: string;
  initialFocusRef?: { current: HTMLElement | null };
  contentClassName?: string;
}

function mergeRefs<T>(
  ...refs: Array<
    | ((value: T | null) => void)
    | { current: T | null }
    | null
    | undefined
  >
) {
  return (value: T | null): void => {
    refs.forEach((ref) => {
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    });
  };
}

export const DialogShell = forwardRef<HTMLDialogElement, DialogShellProps>(
  function DialogShell(
    {
      open,
      onOpenChange,
      title,
      description,
      eyebrow,
      footer,
      children,
      closeLabel = "关闭",
      initialFocusRef,
      className,
      contentClassName,
      onCancel,
      onClose,
      onClick,
      ...props
    },
    forwardedRef,
  ) {
    const generatedId = useId().replace(/:/g, "");
    const titleId = `fh-dialog-${generatedId}-title`;
    const descriptionId = `fh-dialog-${generatedId}-description`;
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const previousActiveElement = useRef<HTMLElement | null>(null);
    const wasOpen = useRef(false);
    const closeButtonRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (open && !dialog.open) {
        previousActiveElement.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        dialog.showModal();
        wasOpen.current = true;
        window.requestAnimationFrame(() => {
          const target =
            (initialFocusRef && "current" in initialFocusRef
              ? initialFocusRef.current
              : null) ?? closeButtonRef.current;
          target?.focus();
        });
      } else if (!open && dialog.open) {
        dialog.close();
      }

      if (!open && wasOpen.current) {
        wasOpen.current = false;
        window.requestAnimationFrame(() => previousActiveElement.current?.focus());
      }
    }, [initialFocusRef, open]);

    function handleClose(event: SyntheticEvent<HTMLDialogElement>): void {
      onClose?.(event);
      if (open) onOpenChange(false);
    }

    function handleCancel(event: SyntheticEvent<HTMLDialogElement>): void {
      onCancel?.(event);
      if (!event.defaultPrevented) onOpenChange(false);
    }

    return (
      <dialog
        {...props}
        ref={mergeRefs(dialogRef, forwardedRef)}
        className={cx(
          "fh-dialog-shell m-auto max-h-[min(44rem,calc(100dvh-2rem))] w-[min(42rem,calc(100vw-2rem))] overflow-hidden rounded-[14px] border border-[#355442] bg-[#0b1711] p-0 text-[#dce9e0] shadow-[0_24px_80px_rgba(0,0,0,0.58)] backdrop:bg-[#040b07]/75 backdrop:backdrop-blur-[2px] focus:outline-none",
          className,
        )}
        aria-labelledby={props["aria-labelledby"] ?? titleId}
        aria-describedby={
          props["aria-describedby"] ?? (description ? descriptionId : undefined)
        }
        aria-modal="true"
        onClick={(event) => {
          onClick?.(event);
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
        onCancel={handleCancel}
        onClose={handleClose}
      >
        <div className={cx("fh-dialog-shell__content grid min-h-0", contentClassName)}>
          <header className="flex items-start justify-between gap-4 border-b border-[#294336] bg-[#101f17] px-5 py-4">
            <div className="min-w-0">
              {eyebrow ? (
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#6f907d]">
                  {eyebrow}
                </p>
              ) : null}
              <h2 id={titleId} className="text-base font-semibold tracking-[0.01em] text-[#f0f7f2]">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="mt-1.5 text-sm leading-5 text-[#8fa698]">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label={closeLabel}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-transparent text-lg leading-none text-[#8fa698] transition-colors hover:border-[#3c5b49] hover:bg-[#14291e] hover:text-white motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b9f2ca] focus-visible:ring-offset-2 focus-visible:ring-offset-[#101f17]"
              onClick={() => onOpenChange(false)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto px-5 py-5">{children}</div>
          {footer ? (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[#294336] bg-[#0d1b13] px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      </dialog>
    );
  },
);
