import type { FieldsetHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";

export interface FormSectionProps
  extends Omit<FieldsetHTMLAttributes<HTMLFieldSetElement>, "children"> {
  legend: ReactNode;
  children?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function FormSection({
  legend,
  description,
  actions,
  children,
  className,
  ...props
}: FormSectionProps) {
  return (
    <fieldset
      className={cx(
        "fh-form-section min-w-0 rounded-[14px] border border-[var(--fh-border,#294334)] bg-[var(--fh-canvas,#0d1b14)]/70 p-4 text-[var(--fh-text,#dce9e0)] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] sm:p-5",
        className,
      )}
      {...props}
    >
      <legend className="flex max-w-full items-center gap-3 px-2 text-sm font-semibold tracking-[0.04em] text-[var(--fh-accent,#b9efc9)]">
        <span className="min-w-0 truncate">{legend}</span>
        {actions ? (
          <span className="ml-auto flex shrink-0 items-center gap-2">{actions}</span>
        ) : null}
      </legend>
      {description ? (
        <p className="mt-1 text-xs leading-5 text-[var(--fh-muted,#8fa698)]">{description}</p>
      ) : null}
      <div className={cx("mt-4 grid min-w-0 gap-4", !description && "mt-2")}>
        {children}
      </div>
    </fieldset>
  );
}
