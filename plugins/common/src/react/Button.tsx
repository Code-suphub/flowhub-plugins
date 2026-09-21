import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "border-[var(--fh-accent,#9bd5ad)] bg-[var(--fh-accent,#a9e8bc)] text-[var(--fh-on-accent,#07130d)] shadow-[0_8px_24px_rgba(112,211,145,0.12)] hover:border-[var(--fh-accent,#c4f4d2)] hover:bg-[var(--fh-accent,#b9efc9)]",
  secondary:
    "border-[var(--fh-border,#355244)] bg-[var(--fh-surface,#13231b)] text-[var(--fh-text,#e3eee7)] hover:border-[var(--fh-border,#587866)] hover:bg-[var(--fh-surface,#192d23)]",
  ghost:
    "border-transparent bg-transparent text-[var(--fh-accent,#b8c9bf)] hover:border-[var(--fh-border,#2a4436)] hover:bg-[var(--fh-surface,#14241c)] hover:text-[var(--fh-text,#f0f7f2)]",
  danger:
    "border-[var(--fh-danger,#7f3c42)] bg-[var(--fh-danger-soft,#3a1d21)] text-[var(--fh-text,#ffd9dc)] hover:border-[var(--fh-danger,#b85a63)] hover:bg-[var(--fh-danger-soft,#4a2228)]",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 text-xs tracking-[0.08em]",
  md: "min-h-11 px-4 text-sm tracking-[0.04em]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 rounded-[10px] border font-semibold leading-none transition-[background-color,border-color,color,box-shadow] duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});
