import type { EmailDraft } from '@/lib/queries/email-drafts';

type Status = 'ok' | 'warn' | 'fail';

interface Cell {
  label: string;
  value: string;
  sub: string;
  bar: number; // 0–100
  status: Status;
}

export interface AntiPattern {
  kind?: string;
  line?: number;
  snippet?: string;
  reason?: string;
  severity?: 'minor' | 'major' | 'blocking';
}

interface QualityShape {
  score?: number;
  word_count?: number;
  word_count_target?: [number, number];
  claims_verified?: number;
  claims_total?: number;
  anti_patterns?: AntiPattern[];
  section_variety_score?: number;
  freshness_ok?: boolean;
  previously_featured_count?: number;
  previously_featured_topic?: string;
  cta_count?: number;
  exclamation_marks?: number;
  metric_clarity?: number; // investor-update only
}

function scoreStatus(n: number | undefined): Status {
  if (n == null) return 'warn';
  if (n >= 80) return 'ok';
  if (n >= 60) return 'warn';
  return 'fail';
}

function antiPatternStatus(items: AntiPattern[] | undefined): Status {
  if (!items || items.length === 0) return 'ok';
  if (items.some((a) => a.severity === 'blocking')) return 'fail';
  if (items.some((a) => a.severity === 'major')) return 'warn';
  return 'warn';
}

function wordCountStatus(
  count: number | undefined,
  target: [number, number] | undefined,
): Status {
  if (count == null) return 'warn';
  const [lo, hi] = target ?? [350, 500];
  if (count >= lo && count <= hi) return 'ok';
  if (count >= lo * 0.8 && count <= hi * 1.2) return 'warn';
  return 'fail';
}

function buildNewsletterCells(q: QualityShape): Cell[] {
  const ap = q.anti_patterns ?? [];
  const apMinor = ap.filter((a) => a.severity !== 'blocking').length;
  const apBlocking = ap.filter((a) => a.severity === 'blocking').length;
  const wcTarget = q.word_count_target ?? [350, 500];

  return [
    {
      label: 'Quality score',
      value: q.score != null ? String(q.score) : '—',
      sub: '/ 100',
      bar: q.score ?? 0,
      status: scoreStatus(q.score),
    },
    {
      label: 'Word count',
      value: q.word_count != null ? String(q.word_count) : '—',
      sub: `target ${wcTarget[0]}-${wcTarget[1]}`,
      bar:
        q.word_count != null
          ? Math.min(100, Math.round((q.word_count / wcTarget[1]) * 100))
          : 0,
      status: wordCountStatus(q.word_count, wcTarget),
    },
    {
      label: 'Claims verified',
      value:
        q.claims_total != null
          ? `${q.claims_verified ?? 0} / ${q.claims_total}`
          : (q.claims_verified ?? '—').toString(),
      sub:
        q.claims_total && q.claims_verified === q.claims_total
          ? 'all sources OK'
          : 'check sources',
      bar:
        q.claims_total != null && q.claims_total > 0
          ? Math.round(((q.claims_verified ?? 0) / q.claims_total) * 100)
          : 0,
      status:
        q.claims_total != null && q.claims_verified === q.claims_total
          ? 'ok'
          : 'warn',
    },
    {
      label: 'Anti-patterns',
      value: ap.length.toString(),
      sub: `${apMinor} minor · ${apBlocking} blocking`,
      bar: ap.length === 0 ? 100 : Math.max(0, 100 - ap.length * 25),
      status: antiPatternStatus(ap),
    },
    {
      label: 'Section variety',
      value:
        q.section_variety_score != null
          ? q.section_variety_score.toFixed(2)
          : '—',
      sub:
        q.section_variety_score == null
          ? '—'
          : q.section_variety_score >= 0.7
            ? 'good mix'
            : 'thin variety',
      bar: Math.round((q.section_variety_score ?? 0) * 100),
      status: scoreStatus((q.section_variety_score ?? 0) * 100),
    },
    {
      label: 'Freshness',
      value: q.freshness_ok == null ? '—' : q.freshness_ok ? 'OK' : 'STALE',
      sub: q.freshness_ok ? 'no repeats < 60d' : 'repeats recent edition',
      bar: q.freshness_ok ? 100 : 30,
      status: q.freshness_ok ? 'ok' : 'warn',
    },
    {
      label: 'Previously featured',
      value: (q.previously_featured_count ?? 0).toString(),
      sub: q.previously_featured_topic ?? 'no prior topic match',
      bar:
        q.previously_featured_count != null
          ? Math.max(0, 100 - q.previously_featured_count * 25)
          : 100,
      status: (q.previously_featured_count ?? 0) === 0 ? 'ok' : 'warn',
    },
    {
      label: 'CTAs · exclamations',
      value: `${q.cta_count ?? 0} / ${q.exclamation_marks ?? 0}`,
      sub:
        (q.exclamation_marks ?? 0) === 0 && (q.cta_count ?? 0) > 0
          ? 'on-brand'
          : (q.exclamation_marks ?? 0) > 1
            ? 'too hyped'
            : 'check tone',
      bar: (q.exclamation_marks ?? 0) <= 1 ? 100 : 40,
      status: (q.exclamation_marks ?? 0) <= 1 ? 'ok' : 'warn',
    },
  ];
}

function buildInvestorCells(q: QualityShape): Cell[] {
  const ap = q.anti_patterns ?? [];
  const apBlocking = ap.filter((a) => a.severity === 'blocking').length;
  const wcTarget = q.word_count_target ?? [250, 400];
  return [
    {
      label: 'Quality score',
      value: q.score != null ? String(q.score) : '—',
      sub: '/ 100',
      bar: q.score ?? 0,
      status: scoreStatus(q.score),
    },
    {
      label: 'Metric clarity',
      value:
        q.metric_clarity != null ? q.metric_clarity.toFixed(2) : '—',
      sub: 'numbers > adjectives',
      bar: Math.round((q.metric_clarity ?? 0) * 100),
      status: scoreStatus((q.metric_clarity ?? 0) * 100),
    },
    {
      label: 'Word count',
      value: q.word_count != null ? String(q.word_count) : '—',
      sub: `target ${wcTarget[0]}-${wcTarget[1]}`,
      bar:
        q.word_count != null
          ? Math.min(100, Math.round((q.word_count / wcTarget[1]) * 100))
          : 0,
      status: wordCountStatus(q.word_count, wcTarget),
    },
    {
      label: 'Anti-patterns',
      value: ap.length.toString(),
      sub: `${ap.length} flagged · ${apBlocking} blocking`,
      bar: ap.length === 0 ? 100 : Math.max(0, 100 - ap.length * 25),
      status: antiPatternStatus(ap),
    },
  ];
}

export function QualityScorecard({ draft }: { draft: EmailDraft }) {
  const quality = ((draft.metadata?.quality ?? {}) as QualityShape) || {};
  const cells =
    draft.type === 'investor_update'
      ? buildInvestorCells(quality)
      : buildNewsletterCells(quality);

  if (Object.keys(quality).length === 0) {
    return (
      <div
        style={{
          padding: 'var(--space-3) var(--space-4)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--fg-faint)',
          letterSpacing: '.04em',
          background: 'var(--bg-sunken)',
          borderBottom: '1px solid var(--border-soft)',
        }}
      >
        No quality scorecard — pipeline did not write metadata.quality for this
        draft.
      </div>
    );
  }

  return (
    <div className="nl-quality-grid" role="list" aria-label="Quality scorecard">
      {cells.map((c) => (
        <div key={c.label} className={`nl-quality-cell ${c.status}`} role="listitem">
          <div className="qlabel">{c.label}</div>
          <div className="qvalue">
            {c.value} <span className="qsub">{c.sub}</span>
          </div>
          <div className="qbar">
            <div style={{ width: `${Math.max(0, Math.min(100, c.bar))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AntiPatternList({
  draft,
  onFix,
}: {
  draft: EmailDraft;
  onFix?: (ap: AntiPattern, index: number) => void;
}) {
  const quality = (draft.metadata?.quality ?? {}) as QualityShape;
  const items = quality.anti_patterns ?? [];
  if (items.length === 0) return null;

  return (
    <div className="nl-ap-list">
      <h6>Anti-patterns flagged · click "fix" to hand the section to chat</h6>
      {items.map((ap, i) => {
        const status: Status = ap.severity === 'blocking' ? 'fail' : 'warn';
        return (
          <div key={i} className={`nl-ap-item ${status}`}>
            <div className="mark">!</div>
            <div>
              <div>
                {ap.kind ?? 'Anti-pattern'}
                {ap.snippet ? ' · ' : ''}
                {ap.snippet && <em>"{ap.snippet}"</em>}
              </div>
              {ap.line != null && (
                <div className="where">body line {ap.line}</div>
              )}
            </div>
            <button
              type="button"
              className="fix"
              onClick={() => onFix?.(ap, i)}
              disabled={!onFix}
              title={
                onFix
                  ? 'Open a Claude session seeded with this section + the anti-pattern'
                  : 'Fix in chat — handler not wired'
              }
            >
              ↗ fix in chat
            </button>
          </div>
        );
      })}
    </div>
  );
}
