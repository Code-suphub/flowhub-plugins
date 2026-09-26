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
  required?: boolean;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
  error,
  required = false,
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
        className="fh-field__label pointer-events-none text-sm font-medium normal-case tracking-normal text-[var(--fh-muted,#9db3a6)]"
      >
        {label}{required ? <><span aria-hidden="true" className="fh-field__required ml-1 text-[var(--fh-danger,#ff9fa8)]">*</span><span className="sr-only">必填</span></> : null}
      </label>
      {control}
      {error ? (
        <p
          id={messageId}
          className="fh-field__error text-xs leading-5 text-[var(--fh-danger,#ff9fa8)]"
          role="alert"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={messageId}
          className="fh-field__hint text-xs leading-5 text-[var(--fh-muted,#789082)]"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
