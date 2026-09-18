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
    "border-[#9bd5ad] bg-[#a9e8bc] text-[#07130d] shadow-[0_8px_24px_rgba(112,211,145,0.12)] hover:border-[#c4f4d2] hover:bg-[#b9efc9]",
  secondary:
    "border-[#355244] bg-[#13231b] text-[#e3eee7] hover:border-[#587866] hover:bg-[#192d23]",
  ghost:
    "border-transparent bg-transparent text-[#b8c9bf] hover:border-[#2a4436] hover:bg-[#14241c] hover:text-[#f0f7f2]",
  danger:
    "border-[#7f3c42] bg-[#3a1d21] text-[#ffd9dc] hover:border-[#b85a63] hover:bg-[#4a2228]",
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
        "inline-flex select-none items-center justify-center gap-2 rounded-[10px] border font-semibold leading-none transition-[background-color,border-color,color,box-shadow] duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b9f2ca] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09130e] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
});
