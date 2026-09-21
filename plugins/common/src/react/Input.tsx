import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "./cx";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        "fh-input min-h-11 w-full min-w-0 rounded-[10px] border border-[var(--fh-border,#304b3c)] bg-[var(--fh-canvas,#0b1711)] px-3.5 text-sm text-[var(--fh-text,#e5f0e9)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] outline-none transition-[border-color,background-color,box-shadow] placeholder:text-[var(--fh-muted,#70877a)] hover:border-[var(--fh-border,#557462)] hover:bg-[var(--fh-canvas,#0e1c15)] focus-visible:border-[var(--fh-accent,#a9e8bc)] focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)]/15 aria-invalid:border-[var(--fh-danger,#ff8f9a)] aria-invalid:ring-2 aria-invalid:ring-[var(--fh-danger,#ff8f9a)]/15 focus-visible:aria-invalid:border-[var(--fh-danger,#ff8f9a)] focus-visible:aria-invalid:ring-[var(--fh-danger,#ff8f9a)]/15 forced-colors:focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-45 read-only:cursor-default read-only:bg-[var(--fh-canvas,#0e1a13)] motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
});
