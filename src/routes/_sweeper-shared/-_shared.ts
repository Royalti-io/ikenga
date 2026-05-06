// Shared helpers used by the sweeper page. These were previously co-located
// with the Tasks routes; the Tasks UI is now a pkg (com.ikenga.tasks) so the
// helpers sweeper still needs were moved here.

export function relativeAgo(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
