import { type HTMLAttributes, type ReactNode } from "react";

import { cx } from "./cx";

export type ToolbarDensity = "compact" | "comfortable";

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  label?: string;
  density?: ToolbarDensity;
}

export function Toolbar({
  children,
  label = "工具栏",
  density = "compact",
  className,
  ...props
}: ToolbarProps) {
  return (
    <div
      {...props}
      role="toolbar"
      aria-label={props["aria-label"] ?? label}
      className={cx(
        "fh-toolbar flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[10px] border border-[#294336] bg-[#101f17] text-sm",
        density === "compact" ? "p-1.5" : "p-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
