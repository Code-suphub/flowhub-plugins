import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cx } from "./cx";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(
          "fh-textarea min-h-28 w-full min-w-0 resize-y rounded-[10px] border border-[#304b3c] bg-[#0b1711] px-3.5 py-3 text-sm leading-6 text-[#e5f0e9] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] outline-none transition-[border-color,background-color,box-shadow] placeholder:text-[#70877a] hover:border-[#557462] hover:bg-[#0e1c15] focus-visible:border-[#a9e8bc] focus-visible:ring-2 focus-visible:ring-[#b9f2ca] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09130e] aria-invalid:border-[#ff8f9a] aria-invalid:ring-2 aria-invalid:ring-[#ff8f9a] disabled:cursor-not-allowed disabled:opacity-45 read-only:cursor-default read-only:bg-[#0e1a13] motion-reduce:transition-none",
          className,
        )}
        {...props}
      />
    );
  },
);
