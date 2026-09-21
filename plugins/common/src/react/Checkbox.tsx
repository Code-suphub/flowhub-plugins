import {
  forwardRef,
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

import { cx } from "./cx";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange" | "type"> {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  containerClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    id,
    label,
    checked,
    onChange,
    className,
    containerClassName,
    disabled,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? `fh-checkbox-${generatedId.replace(/:/g, "")}`;

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange(event.currentTarget.checked);
  }

  return (
    <label
      htmlFor={inputId}
      className={cx(
        "fh-checkbox inline-flex min-h-11 cursor-pointer items-center gap-3 text-sm text-[var(--fh-text,#c7d6cd)]",
        disabled && "cursor-not-allowed opacity-45",
        containerClassName,
      )}
    >
      <input
        {...props}
        ref={ref}
        id={inputId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        className={cx(
          "peer h-5 w-5 shrink-0 cursor-pointer appearance-none rounded-[5px] border border-[var(--fh-border,#496354)] bg-[var(--fh-canvas,#0b1711)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors checked:border-[var(--fh-accent,#a9e8bc)] checked:bg-[var(--fh-accent,#a9e8bc)] checked:bg-[linear-gradient(135deg,transparent_44%,#08140d_44%,#08140d_56%,transparent_56%),linear-gradient(45deg,transparent_48%,#08140d_48%,#08140d_58%,transparent_58%)] checked:bg-[length:7px_12px,5px_7px] checked:bg-[position:8px_2px,4px_7px] checked:bg-no-repeat motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)] disabled:cursor-not-allowed",
          className,
        )}
      />
      <span className="leading-5 peer-focus-visible:text-[var(--fh-text,#eef8f1)]">{label}</span>
    </label>
  );
});
