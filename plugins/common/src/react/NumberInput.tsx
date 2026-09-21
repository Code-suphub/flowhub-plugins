import {
  forwardRef,
  type ChangeEventHandler,
  type InputHTMLAttributes,
} from "react";

import { cx } from "./cx";

export interface NumberInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    | "type"
    | "value"
    | "defaultValue"
    | "onChange"
    | "min"
    | "max"
    | "step"
    | "className"
  > {
  /** Keep this as a string while the user is editing values such as an empty input. */
  value?: number | string;
  min?: number | string;
  max?: number | string;
  step?: number | "any";
  onChange?: ChangeEventHandler<HTMLInputElement>;
  /** Called by the decrement/increment buttons with the next input value. */
  onValueChange?: (value: string) => void;
  className?: string;
  containerClassName?: string;
  decrementAriaLabel?: string;
  incrementAriaLabel?: string;
}

function finiteNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) {
    const [coefficient, exponent] = text.split("e-");
    return (coefficient.split(".")[1]?.length ?? 0) + Number(exponent);
  }
  return text.split(".")[1]?.length ?? 0;
}

function formatNumber(value: number, precision: number): string {
  const rounded = Number(value.toFixed(Math.min(precision, 12)));
  return String(rounded);
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      className,
      containerClassName,
      decrementAriaLabel = "减少",
      incrementAriaLabel = "增加",
      disabled = false,
      readOnly = false,
      min,
      max,
      step = 1,
      value,
      onValueChange,
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref,
  ) {
    const minValue = finiteNumber(min);
    const maxValue = finiteNumber(max);
    const rawStep = step === "any" ? 1 : finiteNumber(step) ?? 1;
    const stepValue = Math.abs(rawStep) || 1;
    const stepPrecision = decimalPlaces(stepValue);
    const isInvalid = ariaInvalid === true || ariaInvalid === "true";

    function changeBy(direction: -1 | 1): void {
      if (disabled || readOnly || !onValueChange) return;

      const current = finiteNumber(value);
      const base = current ?? minValue ?? 0;
      const next = Math.min(
        maxValue ?? Number.POSITIVE_INFINITY,
        Math.max(minValue ?? Number.NEGATIVE_INFINITY, base + direction * stepValue),
      );
      const precision = Math.max(
        stepPrecision,
        decimalPlaces(minValue ?? 0),
        decimalPlaces(maxValue ?? 0),
      );
      onValueChange(formatNumber(next, precision));
    }

    const buttonClassName =
      "inline-flex min-h-11 w-11 shrink-0 items-center justify-center border-[var(--fh-border,#304b3c)] bg-[var(--fh-surface,#102019)] text-lg leading-none text-[var(--fh-accent,#b9efc9)] transition-[background-color,border-color,color] hover:border-[var(--fh-border,#557462)] hover:bg-[var(--fh-surface,#183024)] hover:text-[var(--fh-text,#ffffff)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none";

    return (
      <div
        className={cx(
          "fh-number-input flex min-w-0 overflow-hidden rounded-[10px] border border-[var(--fh-border,#304b3c)] bg-[var(--fh-canvas,#0b1711)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-[border-color,box-shadow] focus-within:border-[var(--fh-accent,#a9e8bc)] focus-within:ring-2 focus-within:ring-[var(--fh-accent,#b9f2ca)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--fh-canvas,#09130e)] aria-invalid:border-[var(--fh-danger,#ff8f9a)] motion-reduce:transition-none",
          isInvalid && "border-[var(--fh-danger,#ff8f9a)]",
          disabled && "opacity-45",
          containerClassName,
        )}
        aria-invalid={ariaInvalid}
      >
        <button
          type="button"
          className={cx(buttonClassName, "border-r")}
          aria-label={decrementAriaLabel}
          disabled={disabled || readOnly || !onValueChange}
          onClick={() => changeBy(-1)}
        >
          <span aria-hidden="true">−</span>
        </button>
        <input
          {...props}
          ref={ref}
          type="number"
          value={value ?? ""}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={ariaInvalid}
          className={cx(
            "fh-number-input__field min-h-11 min-w-0 flex-1 appearance-none border-0 bg-transparent px-3 text-center text-sm text-[var(--fh-text,#e5f0e9)] outline-none placeholder:text-[var(--fh-muted,#70877a)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fh-accent,#b9f2ca)] aria-invalid:text-[var(--fh-danger,#ffb1b8)] read-only:cursor-default disabled:cursor-not-allowed",
            className,
          )}
        />
        <button
          type="button"
          className={cx(buttonClassName, "border-l")}
          aria-label={incrementAriaLabel}
          disabled={disabled || readOnly || !onValueChange}
          onClick={() => changeBy(1)}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    );
  },
);
