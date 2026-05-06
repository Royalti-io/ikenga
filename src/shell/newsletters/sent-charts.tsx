import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  newsletterStatsQuery,
  type NewsletterStatsPoint,
} from '@/lib/queries/newsletters';

const PAD_LEFT = 40;
const PAD_RIGHT = 12;
const PAD_TOP = 20;
const PAD_BOTTOM = 48;

function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

interface XYProjectorOpts {
  width: number;
  height: number;
  yMin: number;
  yMax: number;
  count: number;
}

function makeProjector({ width, height, yMin, yMax, count }: XYProjectorOpts) {
  const innerW = width - PAD_LEFT - PAD_RIGHT;
  const innerH = height - PAD_TOP - PAD_BOTTOM;
  const step = count > 1 ? innerW / (count - 1) : 0;
  return {
    x: (i: number) => PAD_LEFT + i * step,
    y: (v: number) =>
      PAD_TOP + innerH - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * innerH,
  };
}

function polylinePoints(
  values: number[],
  proj: { x: (i: number) => number; y: (v: number) => number },
): string {
  return values.map((v, i) => `${proj.x(i).toFixed(1)},${proj.y(v).toFixed(1)}`).join(' ');
}

// ─── Health alert strip ────────────────────────────────────────────────────

function HealthAlertStrip({ rows }: { rows: NewsletterStatsPoint[] }) {
  const since = Date.now() - 30 * 86_400_000;
  const flagged = rows.filter(
    (r) =>
      new Date(r.sentAt).getTime() >= since &&
      ((r.bounceRate ?? 0) > 0.02 || (r.complaintRate ?? 0) > 0.001),
  );
  if (flagged.length === 0) return null;
  return (
    <div className="nl-health-strip">
      {flagged.map((r) => {
        const fail =
          (r.bounceRate ?? 0) > 0.05 || (r.complaintRate ?? 0) > 0.001;
        return (
          <div key={r.id} className={`nl-health-row ${fail ? 'fail' : 'warn'}`}>
            <div className="mark">!</div>
            <div>
              <strong style={{ color: 'var(--fg)' }}>{r.subject || r.edition}</strong>{' '}
              — bounce{' '}
              <strong
                style={{
                  color: fail ? 'var(--danger)' : 'hsl(38,75%,60%)',
                }}
              >
                {(r.bounceRate * 100).toFixed(1)}%
              </strong>
              , complaint{' '}
              <strong
                style={{
                  color: fail ? 'var(--danger)' : 'hsl(38,75%,60%)',
                }}
              >
                {(r.complaintRate * 100).toFixed(2)}%
              </strong>
              .
            </div>
            <div className="meta">
              {fmtDateShort(r.sentAt)} · {r.recipients.toLocaleString()} recipients
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Engagement trend ──────────────────────────────────────────────────────

function EngagementTrend({ rows }: { rows: NewsletterStatsPoint[] }) {
  const points = rows.slice(-11);
  const W = 600;
  const H = 180;
  const proj = makeProjector({
    width: W,
    height: H,
    yMin: 0,
    yMax: 0.5,
    count: points.length,
  });
  const opens = points.map((p) => p.openRate);
  const clicks = points.map((p) => p.clickRate);
  return (
    <ChartCard
      title="Engagement trend"
      scale={`last ${points.length} editions · open + click`}
      legend={[
        { color: 'var(--achievement)', label: 'open %' },
        { color: 'var(--tint-fg-active)', label: 'click %' },
      ]}
    >
      <svg className="nl-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="grid">
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0)} y2={proj.y(0)} />
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0.25)} y2={proj.y(0.25)} />
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0.5)} y2={proj.y(0.5)} />
        </g>
        <g className="axis">
          <text x={PAD_LEFT - 6} y={proj.y(0.5) + 4} textAnchor="end">50%</text>
          <text x={PAD_LEFT - 6} y={proj.y(0.25) + 4} textAnchor="end">25%</text>
          <text x={PAD_LEFT - 6} y={proj.y(0) + 4} textAnchor="end">0%</text>
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0)} y2={proj.y(0)} />
        </g>
        {points.length > 0 && (
          <>
            <polyline className="line-open" points={polylinePoints(opens, proj)} />
            <polyline className="line-click" points={polylinePoints(clicks, proj)} />
            {opens.map((v, i) => (
              <circle
                key={`o${i}`}
                className="dot dot-open"
                cx={proj.x(i)}
                cy={proj.y(v)}
              />
            ))}
            {clicks.map((v, i) => (
              <circle
                key={`c${i}`}
                className="dot dot-click"
                cx={proj.x(i)}
                cy={proj.y(v)}
              />
            ))}
          </>
        )}
        <g className="axis">
          {points.length > 0 && (
            <>
              <text x={PAD_LEFT} y={H - 24}>{fmtDateShort(points[0].sentAt)}</text>
              <text x={W - PAD_RIGHT} y={H - 24} textAnchor="end">
                {fmtDateShort(points[points.length - 1].sentAt)}
              </text>
            </>
          )}
        </g>
      </svg>
    </ChartCard>
  );
}

// ─── Deliverability trend (bounce + complaint × 10) ────────────────────────

function DeliverabilityTrend({ rows }: { rows: NewsletterStatsPoint[] }) {
  const points = rows.slice(-11);
  const W = 600;
  const H = 180;
  // Y scale = bounce % up to 5%. Complaint plotted as complaint × 10.
  const proj = makeProjector({
    width: W,
    height: H,
    yMin: 0,
    yMax: 0.05,
    count: points.length,
  });
  const bounces = points.map((p) => p.bounceRate);
  const complaints = points.map((p) => p.complaintRate * 10);
  return (
    <ChartCard
      title="Deliverability trend"
      scale={`bounce + complaint · last ${points.length} editions`}
      legend={[
        { color: 'hsl(38,75%,55%)', label: 'bounce %' },
        { color: 'var(--danger)', label: 'complaint % × 10' },
      ]}
    >
      <svg className="nl-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="grid">
          {[0, 0.01, 0.03, 0.05].map((v) => (
            <line
              key={v}
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={proj.y(v)}
              y2={proj.y(v)}
            />
          ))}
        </g>
        <g className="axis">
          <text x={PAD_LEFT - 6} y={proj.y(0.05) + 4} textAnchor="end">5%</text>
          <text x={PAD_LEFT - 6} y={proj.y(0.03) + 4} textAnchor="end">3%</text>
          <text x={PAD_LEFT - 6} y={proj.y(0.01) + 4} textAnchor="end">1%</text>
          <text x={PAD_LEFT - 6} y={proj.y(0) + 4} textAnchor="end">0</text>
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0)} y2={proj.y(0)} />
        </g>
        <line
          className="threshold threshold-danger"
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={proj.y(0.05)}
          y2={proj.y(0.05)}
        />
        <text
          x={W - PAD_RIGHT}
          y={proj.y(0.05) - 4}
          textAnchor="end"
          className="threshold-label danger"
        >
          5% bounce ceiling · Resend
        </text>
        <line
          className="threshold threshold-warn"
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={proj.y(0.02)}
          y2={proj.y(0.02)}
        />
        <text x={PAD_LEFT} y={proj.y(0.02) - 4} className="threshold-label warn">
          2% bounce warning
        </text>
        <line
          className="threshold threshold-danger"
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={proj.y(0.001 * 10)}
          y2={proj.y(0.001 * 10)}
          strokeDasharray="2 4"
        />
        <text
          x={W - PAD_RIGHT}
          y={proj.y(0.001 * 10) + 12}
          textAnchor="end"
          className="threshold-label danger"
        >
          0.1% complaint ceiling · Resend
        </text>
        {points.length > 0 && (
          <>
            <polyline className="line-bounce" points={polylinePoints(bounces, proj)} />
            <polyline
              className="line-complaint"
              points={polylinePoints(complaints, proj)}
            />
            {bounces.map((v, i) => (
              <circle
                key={`b${i}`}
                className="dot dot-bounce"
                cx={proj.x(i)}
                cy={proj.y(v)}
              />
            ))}
            {complaints.map((v, i) => (
              <circle
                key={`cm${i}`}
                className="dot dot-complaint"
                cx={proj.x(i)}
                cy={proj.y(v)}
              />
            ))}
          </>
        )}
        <g className="axis">
          {points.length > 0 && (
            <>
              <text x={PAD_LEFT} y={H - 24}>{fmtDateShort(points[0].sentAt)}</text>
              <text x={W - PAD_RIGHT} y={H - 24} textAnchor="end">
                {fmtDateShort(points[points.length - 1].sentAt)}
              </text>
            </>
          )}
        </g>
      </svg>
    </ChartCard>
  );
}

// ─── Edition comparator (grouped bars · last 6) ────────────────────────────

function EditionComparator({ rows }: { rows: NewsletterStatsPoint[] }) {
  const points = rows.slice(-6);
  const W = 600;
  const H = 200;
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const yMax = 0.5;
  const yScale = (v: number) =>
    PAD_TOP + (H - PAD_TOP - 60) - (clamp(v, 0, yMax) / yMax) * (H - PAD_TOP - 60);
  const slotW = innerW / Math.max(1, points.length);
  const barW = 22;
  const groupW = barW * 2 + 4;
  return (
    <ChartCard
      title="Edition comparator"
      scale={`last ${points.length} editions · grouped bar`}
      legend={[
        { color: 'var(--achievement)', label: 'open %' },
        { color: 'var(--tint-fg-active)', label: 'click %' },
      ]}
    >
      <svg className="nl-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="grid">
          {[0, 0.17, 0.33, 0.5].map((v) => (
            <line
              key={v}
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={yScale(v)}
              y2={yScale(v)}
            />
          ))}
        </g>
        <g className="axis">
          <text x={PAD_LEFT - 6} y={yScale(0.5) + 4} textAnchor="end">50%</text>
          <text x={PAD_LEFT - 6} y={yScale(0.33) + 4} textAnchor="end">33%</text>
          <text x={PAD_LEFT - 6} y={yScale(0.17) + 4} textAnchor="end">17%</text>
          <text x={PAD_LEFT - 6} y={yScale(0) + 4} textAnchor="end">0%</text>
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={yScale(0)} y2={yScale(0)} />
        </g>
        {points.map((p, i) => {
          const slotCenter = PAD_LEFT + i * slotW + slotW / 2;
          const openX = slotCenter - groupW / 2;
          const clickX = openX + barW + 4;
          const openY = yScale(p.openRate);
          const clickY = yScale(p.clickRate);
          return (
            <g key={p.id}>
              <rect
                className="bar-open"
                x={openX}
                y={openY}
                width={barW}
                height={yScale(0) - openY}
              />
              <rect
                className="bar-click"
                x={clickX}
                y={clickY}
                width={barW}
                height={yScale(0) - clickY}
              />
              <text
                x={slotCenter}
                y={H - 22}
                textAnchor="middle"
                className="label-edition"
              >
                {fmtDateShort(p.sentAt)}
              </text>
              <text
                x={slotCenter}
                y={H - 10}
                textAnchor="middle"
                className="label-edition"
              >
                {(p.openRate * 100).toFixed(0)}% / {(p.clickRate * 100).toFixed(1)}%
              </text>
            </g>
          );
        })}
      </svg>
    </ChartCard>
  );
}

// ─── Channel split (twin sparklines) ───────────────────────────────────────

function ChannelSplit({ rows }: { rows: NewsletterStatsPoint[] }) {
  const listmonk = rows.filter((r) => r.deliverySystem === 'listmonk');
  const resend = rows.filter((r) => r.deliverySystem === 'resend');

  return (
    <ChartCard
      title="Channel split"
      scale="Listmonk vs Resend · open % · last 90d"
      legend={[
        { label: `Listmonk · ${listmonk.length} sends` },
        { label: `Resend · ${resend.length} sends` },
      ]}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
        <Sparkline rows={listmonk} channelLabel="LISTMONK · BULK" yMax={0.5} />
        <Sparkline rows={resend} channelLabel="RESEND · INVESTOR" yMax={1} />
      </div>
    </ChartCard>
  );
}

function Sparkline({
  rows,
  channelLabel,
  yMax,
}: {
  rows: NewsletterStatsPoint[];
  channelLabel: string;
  yMax: number;
}) {
  const W = 280;
  const H = 110;
  const proj = makeProjector({
    width: W,
    height: H,
    yMin: 0,
    yMax,
    count: rows.length,
  });
  const opens = rows.map((r) => r.openRate);
  const clicks = rows.map((r) => r.clickRate);
  const avgOpen =
    rows.length > 0 ? rows.reduce((a, b) => a + b.openRate, 0) / rows.length : 0;
  const avgClick =
    rows.length > 0 ? rows.reduce((a, b) => a + b.clickRate, 0) / rows.length : 0;
  const avgBounce =
    rows.length > 0 ? rows.reduce((a, b) => a + b.bounceRate, 0) / rows.length : 0;
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '.04em',
          color: 'var(--fg-faint)',
          marginBottom: 4,
        }}
      >
        {channelLabel}
      </div>
      <svg className="nl-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="grid">
          <line x1={20} x2={W - 10} y1={proj.y(yMax)} y2={proj.y(yMax)} />
          <line x1={20} x2={W - 10} y1={proj.y(yMax / 2)} y2={proj.y(yMax / 2)} />
          <line x1={20} x2={W - 10} y1={proj.y(0)} y2={proj.y(0)} />
        </g>
        <g className="axis">
          <text x={16} y={proj.y(yMax) + 4} textAnchor="end">
            {(yMax * 100).toFixed(0)}%
          </text>
          <text x={16} y={proj.y(yMax / 2) + 4} textAnchor="end">
            {(yMax * 50).toFixed(0)}
          </text>
          <text x={16} y={proj.y(0) + 4} textAnchor="end">0</text>
        </g>
        {rows.length > 0 && (
          <>
            <polyline className="line-open" points={polylinePoints(opens, proj)} />
            <polyline className="line-click" points={polylinePoints(clicks, proj)} />
          </>
        )}
      </svg>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 4,
          marginTop: 'var(--space-2)',
        }}
      >
        <BignumCell label="avg open" value={`${(avgOpen * 100).toFixed(1)}%`} />
        <BignumCell label="avg click" value={`${(avgClick * 100).toFixed(1)}%`} />
        <BignumCell
          label="avg bounce"
          value={`${(avgBounce * 100).toFixed(1)}%`}
          valueStyle={
            avgBounce > 0.02 ? { color: 'hsl(38,75%,60%)' } : undefined
          }
        />
      </div>
    </div>
  );
}

// ─── Recipient list size trend ─────────────────────────────────────────────

function RecipientListTrend({ rows }: { rows: NewsletterStatsPoint[] }) {
  const points = rows.slice(-11);
  const W = 600;
  const H = 180;
  const max = Math.max(1, ...points.map((p) => p.recipients));
  const proj = makeProjector({
    width: W,
    height: H,
    yMin: 0,
    yMax: max * 1.1,
    count: points.length,
  });
  const sizes = points.map((p) => p.recipients);
  return (
    <ChartCard
      title="Recipient list size"
      scale={`last ${points.length} editions`}
      legend={[{ color: 'var(--fg-muted)', label: 'recipients' }]}
    >
      <svg className="nl-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="grid">
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0)} y2={proj.y(0)} />
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(max / 2)} y2={proj.y(max / 2)} />
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(max)} y2={proj.y(max)} />
        </g>
        <g className="axis">
          <text x={PAD_LEFT - 6} y={proj.y(max) + 4} textAnchor="end">{max.toLocaleString()}</text>
          <text x={PAD_LEFT - 6} y={proj.y(max / 2) + 4} textAnchor="end">
            {Math.round(max / 2).toLocaleString()}
          </text>
          <text x={PAD_LEFT - 6} y={proj.y(0) + 4} textAnchor="end">0</text>
          <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={proj.y(0)} y2={proj.y(0)} />
        </g>
        {points.length > 0 && (
          <>
            <polyline className="line-list" points={polylinePoints(sizes, proj)} />
            {sizes.map((v, i) => (
              <circle
                key={i}
                cx={proj.x(i)}
                cy={proj.y(v)}
                r={2.4}
                fill="var(--fg-muted)"
              />
            ))}
          </>
        )}
      </svg>
    </ChartCard>
  );
}

// ─── Single-edition drilldown ──────────────────────────────────────────────

function EditionDrilldown({ rows }: { rows: NewsletterStatsPoint[] }) {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    sorted[sorted.length - 1]?.id ?? null,
  );
  const selected = sorted.find((r) => r.id === selectedId) ?? sorted[sorted.length - 1] ?? null;

  const avg = useMemo(() => {
    if (sorted.length === 0) return null;
    const tail = sorted.slice(-Math.min(11, sorted.length));
    return {
      recipients: tail.reduce((a, b) => a + b.recipients, 0) / tail.length,
      openRate: tail.reduce((a, b) => a + b.openRate, 0) / tail.length,
      clickRate: tail.reduce((a, b) => a + b.clickRate, 0) / tail.length,
      bounceRate: tail.reduce((a, b) => a + b.bounceRate, 0) / tail.length,
    };
  }, [sorted]);

  if (!selected) {
    return (
      <ChartCard title="Single-edition drilldown" scale="select an edition" full>
        <p style={{ color: 'var(--fg-muted)' }}>No sends yet.</p>
      </ChartCard>
    );
  }

  return (
    <ChartCard
      title="Single-edition drilldown"
      scale="summary stats · click an edition to swap"
      full
    >
      <div className="nl-edition-drill">
        <div className="nl-edition-picker">
          {sorted.map((r) => (
            <button
              key={r.id}
              type="button"
              className={r.id === selected.id ? 'is-on' : ''}
              onClick={() => setSelectedId(r.id)}
            >
              {fmtDateShort(r.sentAt)}
              {r.edition ? ` · ${r.edition}` : ''}
            </button>
          ))}
        </div>
        <div>
          <h4>{selected.subject || selected.edition || 'Edition'}</h4>
          <div className="sub">
            {selected.edition ? `edition ${selected.edition} · ` : ''}
            {selected.deliverySystem} ·{' '}
            {new Date(selected.sentAt).toLocaleString('en-US', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </div>
          <div className="nl-bignum-row" style={{ marginTop: 12 }}>
            <BignumCell label="Recipients" value={selected.recipients.toLocaleString()} />
            <BignumCell
              label="Open rate"
              value={`${(selected.openRate * 100).toFixed(1)}%`}
              delta={
                avg
                  ? {
                      value: `${((selected.openRate - avg.openRate) * 100).toFixed(1)} pts`,
                      kind: selected.openRate >= avg.openRate ? 'up' : 'down',
                    }
                  : undefined
              }
            />
            <BignumCell
              label="Click rate"
              value={`${(selected.clickRate * 100).toFixed(1)}%`}
              delta={
                avg
                  ? {
                      value: `${((selected.clickRate - avg.clickRate) * 100).toFixed(1)} pts`,
                      kind: selected.clickRate >= avg.clickRate ? 'up' : 'down',
                    }
                  : undefined
              }
            />
            <BignumCell
              label="Bounce"
              value={`${(selected.bounceRate * 100).toFixed(1)}%`}
              delta={
                avg
                  ? {
                      value: `${((selected.bounceRate - avg.bounceRate) * 100).toFixed(1)} pts`,
                      kind: selected.bounceRate <= avg.bounceRate ? 'up' : 'down',
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </ChartCard>
  );
}

// ─── Parked card ───────────────────────────────────────────────────────────

function ParkedCard() {
  return (
    <div className="nl-parked-card full">
      <h5>Parked · blocked by schema</h5>
      <div className="nl-parked-row">
        <div className="mark" />
        <div>
          <strong>A/B subject analytics</strong> — would split open rate by{' '}
          <code>subject</code> vs <code>subject_alt</code>. Needs Listmonk variant
          stats per send (not currently captured).
        </div>
      </div>
      <div className="nl-parked-row">
        <div className="mark" />
        <div>
          <strong>Time-of-day heatmap</strong> — needs per-recipient open
          timestamps; <code>newsletter_sends</code> only stores aggregate
          opens_count.
        </div>
      </div>
      <div className="nl-parked-row">
        <div className="mark" />
        <div>
          <strong>Per-segment view</strong> (L5 / All / Investors) — segment
          metadata is not persisted on the send row.
        </div>
      </div>
    </div>
  );
}

// ─── Shared building blocks ────────────────────────────────────────────────

function ChartCard({
  title,
  scale,
  legend,
  children,
  full,
}: {
  title: string;
  scale?: string;
  legend?: { color?: string; label: string }[];
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={`nl-chart-card${full ? ' full' : ''}`}>
      <div className="nl-chart-head">
        <h4>{title}</h4>
        {scale && <span className="scale">{scale}</span>}
        {legend && legend.length > 0 && (
          <span className="legend">
            {legend.map((l) => (
              <span key={l.label} className="nl-chart-legend-item">
                {l.color && <span className="dot" style={{ background: l.color }} />}
                {l.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="nl-chart-body">{children}</div>
    </div>
  );
}

function BignumCell({
  label,
  value,
  valueStyle,
  delta,
}: {
  label: string;
  value: string;
  valueStyle?: React.CSSProperties;
  delta?: { value: string; kind: 'up' | 'down' | 'flat' };
}) {
  return (
    <div className="nl-bignum">
      <div className="lbl">{label}</div>
      <div className="val" style={valueStyle}>{value}</div>
      {delta && (
        <div className={`delta ${delta.kind}`}>
          {delta.kind === 'up' ? '▲' : delta.kind === 'down' ? '▼' : '–'} {delta.value}
        </div>
      )}
    </div>
  );
}

// ─── Public entry: full charts grid ────────────────────────────────────────

interface SentChartsProps {
  typeFilter: 'all' | 'newsletter' | 'investor_update';
  channelFilter: 'all' | 'listmonk' | 'resend' | 'smtp';
}

export function SentCharts({ typeFilter, channelFilter }: SentChartsProps) {
  const { data, isLoading, error } = useQuery(newsletterStatsQuery({ days: 90 }));

  const filtered = useMemo(() => {
    const rows = data ?? [];
    return rows.filter((r) => {
      if (typeFilter !== 'all' && r.draftType !== typeFilter && r.draftType !== 'unknown')
        return false;
      if (channelFilter !== 'all' && r.deliverySystem !== channelFilter) return false;
      return true;
    });
  }, [data, typeFilter, channelFilter]);

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-6)', color: 'var(--fg-muted)' }}>Loading…</div>
    );
  }
  if (error instanceof Error) {
    return (
      <div style={{ padding: 'var(--space-6)', color: 'var(--danger)' }}>
        Failed to load stats: {error.message}
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--fg-muted)' }}>
        <h3>No newsletter sends in window</h3>
        <p>Once editions ship, charts populate from <code>newsletter_sends</code>.</p>
      </div>
    );
  }

  return (
    <>
      <HealthAlertStrip rows={filtered} />
      <div className="nl-charts-grid">
        <EngagementTrend rows={filtered} />
        <DeliverabilityTrend rows={filtered} />
        <EditionComparator rows={filtered} />
        <ChannelSplit rows={filtered} />
        <RecipientListTrend rows={filtered} />
        <EditionDrilldown rows={filtered} />
        <ParkedCard />
      </div>
    </>
  );
}
