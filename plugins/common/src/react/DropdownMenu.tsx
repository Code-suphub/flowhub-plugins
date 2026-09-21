import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { cx } from './cx';

export interface DropdownMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export interface DropdownMenuProps {
  label: ReactNode;
  ariaLabel: string;
  items: readonly DropdownMenuItem[];
  className?: string;
}

/** Small action menu: focuses enabled items, dismisses outside, restores its trigger. */
export function DropdownMenu({ label, ariaLabel, items, className }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<'first' | 'last'>('first');
  const id = useId();
  const enabled = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  function close(restore = false) {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }
  function positionMenu() {
    if (!trigger.current || !menu.current) return;
    const anchor = trigger.current!.getBoundingClientRect();
    const box = menu.current!.getBoundingClientRect();
    if (!anchor.width || anchor.bottom < 0 || anchor.top > innerHeight) { close(); return; }
    setPosition({ left: Math.max(8, Math.min(innerWidth - box.width - 8, anchor.right - box.width)),
      top: Math.max(8, Math.min(innerHeight - box.height - 8, anchor.bottom + box.height + 6 > innerHeight ? anchor.top - box.height - 6 : anchor.bottom + 6)) });
  }
  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    const buttons = enabled();
    ((firstFocus.current === 'last' ? buttons.at(-1) : buttons[0]) ?? menu.current)?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) positionMenu(); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  return <>
    <Button ref={trigger} size="sm" variant="ghost" className={className} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={ariaLabel}
      onClick={() => { firstFocus.current = 'first'; setOpen(value => !value); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); firstFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'; setOpen(true); } }}>{label}</Button>
    {open ? createPortal(<div ref={menu} id={id} role="menu" tabIndex={-1} aria-label={ariaLabel}
      className="fh-dropdown-menu fixed z-[1000] grid min-w-[136px] max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] gap-1 overflow-auto rounded-lg border border-[var(--fh-border,#355442)] bg-[var(--fh-surface,#101f17)] p-1 shadow-xl"
      style={position}
      onBlur={event => { if (event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}
      onKeyDown={event => {
        const buttons = enabled(), index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') { close(true); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {items.map(item => <button key={item.id} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
        className={cx('rounded-md border-0 bg-transparent px-3 py-2 text-left text-xs hover:bg-[var(--fh-surface-soft,#20382a)] focus:bg-[var(--fh-surface-soft,#20382a)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40', item.danger ? 'text-[var(--fh-danger,#ff9fa8)]' : 'text-[var(--fh-text,#dce9e0)]')}
        onClick={() => { close(true); item.onSelect(); }}>{item.label}</button>)}
    </div>, document.body) : null}
  </>;
}
