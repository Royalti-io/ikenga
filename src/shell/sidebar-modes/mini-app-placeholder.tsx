import type { MiniApp } from '../mini-apps-config';

export function MiniAppPlaceholder({ app }: { app: MiniApp }) {
  const { Icon } = app;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Icon className="mb-3 h-10 w-10 text-muted-foreground/60" />
      <div className="text-sm font-medium text-foreground">{app.name}</div>
      <div className="mt-1 max-w-[220px] text-xs text-muted-foreground">
        {app.description}
      </div>
      <div className="mt-3 inline-flex items-center rounded border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {app.phaseTag}
      </div>
      <div className="mt-3 text-[11px] text-muted-foreground">
        Lands when its phase ships. Treat the rail icon as an install slot.
      </div>
    </div>
  );
}
