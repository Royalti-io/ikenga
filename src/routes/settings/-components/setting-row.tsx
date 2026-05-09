import type { ReactNode } from 'react';

import { cn } from '@/components/ui/utils';

interface SettingRowProps {
  label: ReactNode;
  desc?: ReactNode;
  /** When true, control flows below the label/desc instead of right of it. */
  stacked?: boolean;
  children: ReactNode;
  className?: string;
}

export function SettingRow({
  label,
  desc,
  stacked,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'px-4 py-3',
        stacked
          ? 'space-y-3'
          : 'grid grid-cols-[1fr_auto] items-center gap-4',
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {desc && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            {desc}
          </div>
        )}
      </div>
      <div className={cn(stacked ? 'w-full' : 'shrink-0')}>{children}</div>
    </div>
  );
}
