import { Button } from "./Button";
import { cx } from "./cx";

export interface PaginationProps {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  ariaLabel?: string;
  className?: string;
}

export function Pagination({
  page,
  pages,
  onChange,
  ariaLabel = "分页",
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.floor(pages) || 1);
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor(page) || 1));

  return (
    <nav
      className={cx(
        "fh-pagination flex flex-wrap items-center justify-end gap-2",
        className,
      )}
      aria-label={ariaLabel}
    >
      <Button
        size="sm"
        variant="ghost"
        disabled={currentPage <= 1}
        aria-label="上一页"
        onClick={() => onChange(currentPage - 1)}
      >
        上一页
      </Button>
      <output
        className="min-w-20 text-center font-mono text-xs tracking-[0.08em] text-[var(--fh-muted,#8fa698)]"
        aria-live="polite"
        aria-atomic="true"
      >
        {currentPage} / {totalPages}
      </output>
      <Button
        size="sm"
        variant="ghost"
        disabled={currentPage >= totalPages}
        aria-label="下一页"
        onClick={() => onChange(currentPage + 1)}
      >
        下一页
      </Button>
    </nav>
  );
}
