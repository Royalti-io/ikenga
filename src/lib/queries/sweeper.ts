import { fsRead } from '@/lib/tauri-cmd';

export interface SweepAction {
  id: string;
  full_id: string;
  title: string;
  action: 'auto_close' | 'flag_review' | 'nudge' | 'escalate';
  confidence?: number;
  signal_source?: string;
  evidence?: unknown;
  age_days?: number;
  assigned_to?: string;
  due_date?: string | null;
}

export interface SweepEntry {
  ts: string;
  dry_run: boolean;
  scanned: number;
  auto_closes: SweepAction[];
  review_flags: SweepAction[];
  nudges: SweepAction[];
}

const SWEEP_LOG = '~/royalti-co/.company/task-health/sweep-log.jsonl';

export async function loadLatestSweep(): Promise<{
  latest: SweepEntry | null;
  totalSweeps: number;
}> {
  let text: string;
  try {
    const res = await fsRead(SWEEP_LOG);
    text = new TextDecoder().decode(new Uint8Array(res.bytes));
  } catch {
    return { latest: null, totalSweeps: 0 };
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return { latest: null, totalSweeps: 0 };

  // Walk back from the end until a valid line parses (defensive against partial writes)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as SweepEntry;
      return { latest: parsed, totalSweeps: lines.length };
    } catch {
      // try previous
    }
  }
  return { latest: null, totalSweeps: lines.length };
}

export function confidenceTier(c: number | undefined): 1 | 2 | 3 | 4 {
  if (!c) return 1;
  if (c >= 0.95) return 4;
  if (c >= 0.9) return 3;
  if (c >= 0.6) return 2;
  return 1;
}
