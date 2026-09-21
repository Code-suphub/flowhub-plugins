import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cx } from "./cx";

export type TabsOrientation = "horizontal" | "vertical";
export type TabsActivationMode = "automatic" | "manual";

interface TabsContextValue {
  baseId: string;
  value: string | undefined;
  orientation: TabsOrientation;
  activationMode: TabsActivationMode;
  setValue: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(componentName: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error(`${componentName} must be rendered inside Tabs`);
  }
  return context;
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: TabsOrientation;
  activationMode?: TabsActivationMode;
  children: ReactNode;
}

function TabsRoot({
  value: controlledValue,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  activationMode = "automatic",
  className,
  children,
  ...props
}: TabsProps) {
  const generatedId = useId().replace(/:/g, "");
  const baseId = `fh-tabs-${generatedId}`;
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const value = controlledValue ?? uncontrolledValue;

  function setValue(nextValue: string): void {
    if (controlledValue === undefined) setUncontrolledValue(nextValue);
    onValueChange?.(nextValue);
  }

  const context = useMemo<TabsContextValue>(
    () => ({
      baseId,
      value,
      orientation,
      activationMode,
      setValue,
    }),
    [activationMode, baseId, controlledValue, onValueChange, orientation, value],
  );

  return (
    <TabsContext.Provider value={context}>
      <div
        {...props}
        className={cx("fh-tabs min-w-0", className)}
        data-orientation={orientation}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, onKeyDown, children, ...props },
  ref,
) {
  const { orientation, activationMode, setValue } = useTabsContext("TabsList");
  const listRef = useRef<HTMLDivElement | null>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    const isForward =
      orientation === "horizontal"
        ? event.key === "ArrowRight"
        : event.key === "ArrowDown";
    const isBackward =
      orientation === "horizontal"
        ? event.key === "ArrowLeft"
        : event.key === "ArrowUp";

    if (!isForward && !isBackward && event.key !== "Home" && event.key !== "End") {
      return;
    }

    const tabs = Array.from(
      (listRef.current ?? event.currentTarget).querySelectorAll<HTMLButtonElement>(
        '[role="tab"]:not(:disabled):not([aria-disabled="true"])',
      ),
    );
    if (!tabs.length) return;

    const currentTab =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLButtonElement>('[role="tab"]')
        : null;
    const currentIndex = Math.max(0, currentTab ? tabs.indexOf(currentTab) : 0);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (isForward ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;

    event.preventDefault();
    nextTab.focus();
    if (activationMode === "automatic") {
      const nextValue = nextTab.dataset.tabsValue;
      if (nextValue) setValue(nextValue);
    }
  }

  return (
    <div
      {...props}
      ref={(node) => {
        listRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      role="tablist"
      aria-orientation={orientation}
      className={cx(
        "fh-tabs__list flex min-w-0 gap-1 border-b border-[var(--fh-border,#294336)]",
        orientation === "vertical" &&
          "flex-col border-b-0 border-r pr-1",
        className,
      )}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
});

export interface TabsTriggerProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  children: ReactNode;
}

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  function TabsTrigger({ value, className, children, onClick, ...props }, ref) {
    const { baseId, value: activeValue, setValue } = useTabsContext("TabsTrigger");
    const selected = activeValue === value;
    const triggerId = `${baseId}-tab-${value}`;
    const panelId = `${baseId}-panel-${value}`;

    return (
      <button
        {...props}
        ref={ref}
        id={triggerId}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={panelId}
        aria-disabled={props.disabled || undefined}
        tabIndex={selected ? 0 : -1}
        data-tabs-value={value}
        className={cx(
          "fh-tabs__trigger relative inline-flex min-h-11 shrink-0 items-center justify-center gap-2 border-b-2 border-transparent px-3 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--fh-muted,#789082)] transition-[background-color,border-color,color] duration-150 hover:bg-[var(--fh-surface,#12251a)] hover:text-[var(--fh-text,#dcebe1)] motion-reduce:transition-none focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40",
          selected && "border-[var(--fh-accent,#a9e8bc)] text-[var(--fh-accent,#b9efc9)]",
          className,
        )}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !props.disabled) setValue(value);
        }}
      >
        {children}
      </button>
    );
  },
);

export interface TabsPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  children: ReactNode;
  forceMount?: boolean;
}

export function TabsPanel({
  value,
  children,
  forceMount = false,
  className,
  ...props
}: TabsPanelProps) {
  const { baseId, value: activeValue } = useTabsContext("TabsPanel");
  const selected = activeValue === value;

  if (!selected && !forceMount) return null;

  return (
    <div
      {...props}
      id={`${baseId}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!selected}
      tabIndex={0}
      className={cx(
        "fh-tabs__panel min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--fh-accent,#b9f2ca)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--fh-canvas,#09130e)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Panel: TabsPanel,
});
