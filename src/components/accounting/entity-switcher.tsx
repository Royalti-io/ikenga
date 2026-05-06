import { useEntityStore } from '@/lib/finance/entity-store';
import type { EntityFilter } from '@/lib/finance/overview';
import { cn } from '@/components/ui/utils';

const OPTIONS: { value: EntityFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'All entities' },
  { value: 'royalti', label: 'R', title: 'Royalti.io' },
  { value: 'dixtrit', label: 'D', title: 'Dixtrit.media' },
  { value: 'personal', label: 'P', title: 'Personal' },
];

export function EntitySwitcher() {
  const entity = useEntityStore((s) => s.entity);
  const setEntity = useEntityStore((s) => s.setEntity);

  return (
    <div
      role="group"
      aria-label="Entity filter"
      className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = entity === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setEntity(opt.value)}
            title={opt.title}
            aria-pressed={active}
            className={cn(
              'min-w-[2rem] rounded px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-accent text-accent-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
