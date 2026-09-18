import { type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";

export type EmptyStateSize = "compact" | "default";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  eyebrow?: ReactNode;
  size?: EmptyStateSize;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  eyebrow,
  size = "default",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <section
      {...props}
      className={cx(
        "fh-empty-state flex flex-col items-center justify-center rounded-[12px] border border-dashed border-[#355442] bg-[#0b1711] px-6 text-center",
        size === "compact" ? "min-h-40 py-8" : "min-h-64 py-12",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-[10px] border border-[#355442] bg-[#101f17] font-mono text-xl text-[#8fb79e]"
        >
          {icon}
        </div>
      ) : null}
      {eyebrow ? (
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#6f907d]">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="mt-2 text-base font-semibold text-[#e8f2eb]">{title}</h2>
      {description ? (
        <p className="mt-2 max-w-[34rem] text-sm leading-6 text-[#789082]">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </section>
  );
}
