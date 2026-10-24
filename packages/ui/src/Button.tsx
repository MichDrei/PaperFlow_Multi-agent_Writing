import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'success';
type Size = 'xs' | 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  /*
   * 用 brand-600 而不是 500：浅色模式下 500 太亮，白字对比度不够
   * （实测白天模式里"编译/发送"的白字几乎看不见）。
   */
  primary:
    'bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 border border-brand-700/60 shadow-sm shadow-brand-600/25',
  outline: 'bg-ink-850 text-ink-100 hover:bg-ink-800 border border-ink-700',
  ghost: 'bg-transparent text-ink-300 hover:bg-ink-800 hover:text-ink-100 border border-transparent',
  danger: 'bg-accent-rose/15 text-accent-rose hover:bg-accent-rose/25 border border-accent-rose/40',
  success: 'bg-accent-teal/15 text-accent-teal hover:bg-accent-teal/25 border border-accent-teal/40',
};

const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export function Button({
  variant = 'outline',
  size = 'sm',
  icon,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex flex-nowrap items-center justify-center gap-1 font-medium transition-colors select-none',
        'whitespace-nowrap whitespace-pre',
        /*
         * 禁用态不用"整体降透明度"：primary 是白字，降到 45% 后在浅色模式下
         * 等于白底白字，完全看不见（实测"编译/发送"按钮在白天模式消失）。
         * 改成明确的灰底灰字，两套主题下都清楚。
         */
        'disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-400 disabled:border-ink-700 disabled:shadow-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5 shrink-0" /> : <span className="flex shrink-0 items-center">{icon}</span>}
      {children}
    </button>
  );
}

export function IconButton({
  variant = 'ghost',
  size = 'sm',
  icon,
  className,
  title,
  active,
  ...rest
}: Omit<ButtonProps, 'children'> & { title: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center justify-center rounded-md transition-colors',
        size === 'xs' ? 'size-6' : size === 'sm' ? 'size-7' : 'size-9',
        active ? 'bg-brand-500/18 text-brand-400' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
