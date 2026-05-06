// Build a seed prompt for "fix in chat" on a single anti-pattern. The prompt
// includes the surrounding section so Claude has enough context to rewrite
// without round-tripping over the full body.

interface AntiPatternInput {
  kind?: string;
  line?: number;
  snippet?: string;
  reason?: string;
  severity?: 'minor' | 'major' | 'blocking';
}

const CONTEXT_RADIUS = 8; // lines before/after the flagged line

export function extractSection(body: string, line: number | undefined): {
  before: string;
  flagged: string;
  after: string;
  startLine: number;
} {
  const lines = body.split('\n');
  if (!line || line < 1 || line > lines.length) {
    return { before: '', flagged: body, after: '', startLine: 1 };
  }
  const idx = line - 1;
  const start = Math.max(0, idx - CONTEXT_RADIUS);
  const end = Math.min(lines.length, idx + CONTEXT_RADIUS + 1);
  return {
    before: lines.slice(start, idx).join('\n'),
    flagged: lines[idx] ?? '',
    after: lines.slice(idx + 1, end).join('\n'),
    startLine: start + 1,
  };
}

export function buildAntiPatternPrompt(
  ap: AntiPatternInput,
  body: string,
  draftSubject: string | undefined,
): string {
  const section = extractSection(body, ap.line);
  const subjectLine = draftSubject ? `Subject: ${draftSubject}\n\n` : '';
  const reasonLine = ap.reason ? `Reason: ${ap.reason}\n` : '';
  const severityLine = ap.severity ? `Severity: ${ap.severity}\n` : '';

  return `${subjectLine}The newsletter pipeline flagged an anti-pattern in this draft. Rewrite just the flagged section — keep the technical specifics, fix the tone.

Anti-pattern: ${ap.kind ?? 'unspecified'}
${reasonLine}${severityLine}Flagged line (${ap.line ?? '?'}): "${ap.snippet ?? section.flagged.trim()}"

— SECTION (lines ${section.startLine}–${section.startLine + section.before.split('\n').length + section.after.split('\n').length}) —
${section.before}
${section.flagged}
${section.after}

Return only the rewritten section as plain text, ready to paste back into the draft. Do not include the surrounding paragraphs that were already fine. Do not add commentary before or after the rewritten section.`;
}
