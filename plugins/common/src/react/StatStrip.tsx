import { type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";

export type StatTone = "neutral" | "positive" | "warning" | "danger";

export interface StatStripProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  columns?: 2 | 3 | 4 | 5 | 6;
}

const columnClasses: Record<NonNullable<StatStripProps["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-3 lg:grid-cols-6",
};

export function StatStrip({
  children,
  columns = 4,
  className,
  ...props
}: StatStripProps) {
  return (
    <div
      {...props}
      role="list"
      className={cx(
        "fh-stat-strip grid grid-cols-1 overflow-hidden rounded-[12px] border border-[#294336] bg-[#0b1711]",
        columnClasses[columns],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface StatItemProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  trend?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
}

const toneClasses: Record<StatTone, string> = {
  neutral: "text-[#e8f2eb]",
  positive: "text-[#a9e8bc]",
  warning: "text-[#f2cf88]",
  danger: "text-[#ff9fa8]",
};

export function StatItem({
  label,
  value,
  detail,
  trend,
  icon,
  tone = "neutral",
  className,
  ...props
}: StatItemProps) {
  return (
    <div
      {...props}
      role="listitem"
      className={cx(
        "fh-stat-item min-w-0 border-b border-[#22392d] px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-[#789082]">
          {label}
        </span>
        {icon ? (
          <span aria-hidden="true" className="shrink-0 text-[#719782]">
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-2">
        <strong className={cx("truncate font-mono text-xl font-semibold tracking-[-0.03em]", toneClasses[tone])}>
          {value}
        </strong>
        {trend ? <span className="shrink-0 text-xs text-[#8fa698]">{trend}</span> : null}
      </div>
      {detail ? <p className="mt-1 truncate text-xs text-[#71877a]">{detail}</p> : null}
    </div>
  );
}
