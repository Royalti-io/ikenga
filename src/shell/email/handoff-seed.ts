/**
 * Build a seed prompt for "send to chat" on an email draft. Mirrors the
 * newsletter anti-pattern-prompt.ts pattern but for full email replies:
 * the seed includes the thread context (original message), the current
 * draft, and a compact reply-intelligence summary as markdown so Claude
 * has enough context to rewrite without round-trips.
 */

import type { CrmLookupResult } from '@/lib/queries/crm-lookup';

export interface EmailHandoffArgs {
  subject: string;
  body: string;
  toAddress?: string | null;
  fromAddress?: string | null;
  originalSubject?: string | null;
  originalBody?: string | null;
  originalAt?: string | null;
  intel?: CrmLookupResult | null;
}

export function buildEmailHandoffSeed(args: EmailHandoffArgs): string {
  const parts: string[] = [];

  parts.push(
    'Rewrite the email draft below — keep technical specifics, fix tone, address the original message.',
    '',
  );

  if (args.intel) {
    parts.push('— REPLY INTELLIGENCE —');
    if (args.intel.tenant) parts.push(`Tenant: ${args.intel.tenant.name}`);
    if (args.intel.health) parts.push(`Health: ${args.intel.health.label}`);
    if (args.intel.sequence) {
      const seq = args.intel.sequence;
      parts.push(
        `Sequence: ${seq.name} · step ${seq.step ?? '?'} of ${seq.total ?? '?'}`,
      );
    }
    if (args.intel.last_touch) {
      parts.push(
        `Last touch: ${formatShortDate(args.intel.last_touch.at)} · ${args.intel.last_touch.subject}`,
      );
    }
    if (args.intel.owner) parts.push(`Owner: ${args.intel.owner.name}`);
    if (args.intel.risk_flag) parts.push(`Risk: ${args.intel.risk_flag.label}`);
    if (!args.intel.in_crm) {
      parts.push('CRM: no record (cold contact)');
    }
    parts.push('');
  }

  if (args.originalBody) {
    parts.push('— ORIGINAL MESSAGE —');
    if (args.originalSubject) parts.push(`Subject: ${args.originalSubject}`);
    if (args.originalAt) parts.push(`Received: ${formatShortDate(args.originalAt)}`);
    parts.push('');
    parts.push(args.originalBody.trim());
    parts.push('');
  }

  parts.push('— CURRENT DRAFT —');
  if (args.toAddress) parts.push(`To: ${args.toAddress}`);
  if (args.fromAddress) parts.push(`From: ${args.fromAddress}`);
  parts.push(`Subject: ${args.subject}`);
  parts.push('');
  parts.push(args.body.trim());

  return parts.join('\n');
}

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}
