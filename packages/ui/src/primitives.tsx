import type { ReactNode } from 'react';
import { cn } from './cn.js';

export function Avatar({
  initials,
  accent,
  size = 24,
  ring,
  title,
}: {
  initials: string;
  accent: string;
  size?: number;
  ring?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-semibold tracking-tight',
        ring && 'ring-1 ring-white/10',
      )}
      style={{
        width: size,
        height: size,
        background: `${accent}22`,
        color: accent,
        border: `1px solid ${accent}55`,
        fontSize: Math.max(9, size * 0.42),
      }}
    >
      {initials}
    </span>
  );
}

export function Pill({
  children,
  accent,
  className,
  title,
}: {
  children: ReactNode;
  accent?: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[10.5px] font-medium whitespace-nowrap',
        !accent && 'border-ink-700 bg-ink-850 text-ink-300',
        className,
      )}
      style={accent ? { borderColor: `${accent}55`, background: `${accent}18`, color: accent } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ accent, pulse }: { accent: string; pulse?: boolean }) {
  return (
    <span
      className={cn('inline-block size-1.5 rounded-full', pulse && 'pf-pulse')}
      style={{ background: accent }}
    />
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('flex min-h-0 flex-col bg-ink-900', className)}>
      {title && (
        <header className="flex h-9 shrink-0 items-center justify-between border-b border-ink-800 px-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
            {title}
          </div>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {icon && <div className="text-ink-500">{icon}</div>}
      <p className="text-xs font-medium text-ink-300">{title}</p>
      {hint && <p className="max-w-[240px] text-[11px] leading-relaxed text-ink-500">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-md border border-ink-750 bg-ink-900 p-0.5', className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded px-2 py-[3px] text-[11px] font-medium transition-colors',
            value === opt.value ? 'bg-ink-750 text-ink-100' : 'text-ink-400 hover:text-ink-200',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-ink-700 bg-ink-850 px-1 font-mono text-[10px] text-ink-400">
      {children}
    </kbd>
  );
}
