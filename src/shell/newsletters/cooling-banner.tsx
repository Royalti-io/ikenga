import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

interface CoolingBannerProps {
  createdAt: string;
  reviewableAfter: string;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m elapsed`;
  return `${m}m elapsed`;
}

export function CoolingBanner({ createdAt, reviewableAfter }: CoolingBannerProps) {
  const start = new Date(createdAt).getTime();
  const end = new Date(reviewableAfter).getTime();
  const total = Math.max(end - start, 1);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= end) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [end, now]);

  const elapsed = Math.min(Math.max(now - start, 0), total);
  const remaining = Math.max(end - now, 0);
  const pct = Math.round((elapsed / total) * 100);

  if (remaining <= 0) return null;

  return (
    <div className="nl-cool" role="status" aria-live="polite">
      <Clock aria-hidden />
      <span>
        Cooling period · approve in{' '}
        <span className="countdown">{formatRemaining(remaining)}</span> · the
        pipeline asks for two hours so you actually read the draft.
      </span>
      <span className="spacer" />
      <div className="progress" title={`${pct}% of cooling elapsed`}>
        <div style={{ width: `${pct}%` }} />
      </div>
      <span className="meter">
        {pct}% · {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
