import { type Key, type ReactNode } from "react";

import { cx } from "./cx";

export interface DataTableColumn<Row> {
  key: string;
  header: ReactNode;
  accessor?: keyof Row;
  render?: (row: Row, rowIndex: number) => ReactNode;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row, rowIndex: number) => Key;
  emptyState?: ReactNode;
  caption?: ReactNode;
  className?: string;
  tableClassName?: string;
}

function toReactNode(value: unknown): ReactNode {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return value as ReactNode;
}

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  emptyState = "暂无数据",
  caption,
  className,
  tableClassName,
}: DataTableProps<Row>) {
  return (
    <div
      className={cx(
        "fh-table-wrap overflow-x-auto rounded-[12px] border border-[var(--fh-border,#294336)] bg-[var(--fh-canvas,#0b1711)]",
        className,
      )}
    >
      <table
        className={cx(
          "fh-table w-full min-w-[36rem] border-collapse text-left text-sm text-[var(--fh-text,#c8d7ce)]",
          tableClassName,
        )}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="border-b border-[var(--fh-border,#294336)] bg-[var(--fh-surface,#101f17)]">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  "px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--fh-muted,#89a092)]",
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--fh-surface-soft,#22392d)]">
          {rows.length ? (
            rows.map((row, rowIndex) => (
              <tr
                key={getRowKey(row, rowIndex)}
                className="transition-colors hover:bg-[var(--fh-surface,#102118)] motion-reduce:transition-none"
              >
                {columns.map((column) => {
                  const content = column.render
                    ? column.render(row, rowIndex)
                    : column.accessor
                      ? toReactNode(row[column.accessor])
                      : null;

                  return (
                    <td
                      key={column.key}
                      className={cx("px-4 py-3 align-middle", column.className)}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))
          ) : (
            <tr>
              <td
                colSpan={Math.max(1, columns.length)}
                className="fh-table__empty px-6 py-12 text-center text-sm text-[var(--fh-muted,#71877a)]"
              >
                {emptyState}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
