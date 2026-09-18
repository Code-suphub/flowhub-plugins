import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

import { cx } from "./cx";

export interface FieldProps {
  label: ReactNode;
  htmlFor: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
  error,
  className,
}: FieldProps) {
  const generatedId = useId();
  const messageId = `${htmlFor || generatedId}-${error ? "error" : "hint"}`;
  const describedBy = hint || error ? messageId : undefined;
  const child = isValidElement<Record<string, unknown>>(children) ? children : null;
  const control = child
    ? cloneElement(child as ReactElement<Record<string, unknown>>, {
        "aria-describedby": [
          child.props["aria-describedby"],
          describedBy,
        ]
          .filter(Boolean)
          .join(" ") || undefined,
        "aria-invalid": error ? true : child.props["aria-invalid"],
      })
    : children;

  return (
    <div className={cx("fh-field grid min-w-0 gap-2", className)}>
      <label
        htmlFor={htmlFor}
        className="fh-field__label text-xs font-semibold uppercase tracking-[0.12em] text-[#9db3a6]"
      >
        {label}
      </label>
      {control}
      {error ? (
        <p
          id={messageId}
          className="fh-field__error text-xs leading-5 text-[#ff9fa8]"
          role="alert"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={messageId}
          className="fh-field__hint text-xs leading-5 text-[#789082]"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
