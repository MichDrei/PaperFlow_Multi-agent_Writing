/** 极小的 className 组合工具，避免为一行逻辑引入 clsx。 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
