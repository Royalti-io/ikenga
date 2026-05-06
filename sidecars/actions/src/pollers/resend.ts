/**
 * Resend poller — replaces api/webhooks/resend.
 *
 * Two passes per run:
 *   1. Outbound delivery confirmation. Find email_drafts.status='sent' from
 *      the last N hours that have no matching newsletter_sends row; fetch
 *      from Resend; upsert. Catches up newsletter_sends without needing the
 *      delivery webhook.
 *   2. Inbound replies. Poll Resend's receiving API for new inbound to
 *      getroyalti.com; for each new id, fetch full content; classify as
 *      action_needed vs fyi (same regex as the old webhook); upsert into
 *      email_messages; forward fyi-clear ones to the personal inbox.
 *
 * Tracks last-seen cursor in pa_actions_cursor (jobId='resend-poll', key='last_received_id').
 */

import { Resend } from "resend";
import { supabase } from "../lib/supabase";
import { env } from "../lib/env";
import { log } from "../lib/output";
import { getCursor, setCursor } from "../lib/cursor";

const LOOKBACK_HOURS = 6;
const FORWARD_TO = "chinedum@royalti.io";
const FROM_FORWARD = "Royalti Sales <notifications@getroyalti.com>";

let resendClient: Resend | null = null;
function client(): Resend {
  if (!resendClient) resendClient = new Resend(env("RESEND_API_KEY"));
  return resendClient;
}

const AUTOMATED_FROM_RE =
  /noreply|no-reply|mailer-daemon|postmaster|bounce|dmarc|notification|newsletter|unsubscribe/i;
const AUTOMATED_SUBJECT_RE =
  /report domain:|dmarc|delivery (status|notification)|undeliverable/i;

interface OutboundCatchupResult {
  scanned: number;
  upserted: number;
  errors: number;
}

/**
 * Catch up newsletter_sends rows for any email_drafts.status='sent' that
 * don't yet have a matching delivery record. Fetches each from Resend.
 */
async function pollOutboundDeliveries(): Promise<OutboundCatchupResult> {
  const sb = supabase();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  // Drafts marked sent recently with a provider-side id stored on them.
  // delivery_external_id is added by migration 058; until that's applied,
  // skip outbound catchup quietly.
  const { data: drafts, error: draftsErr } = await sb
    .from("email_drafts")
    .select("id, slug, subject, sent_at, delivery_external_id")
    .eq("status", "sent")
    .eq("delivery_system", "resend")
    .gte("sent_at", since)
    .not("delivery_external_id", "is", null)
    .limit(200);

  if (draftsErr) {
    if (draftsErr.code === "42703") {
      log("outbound: delivery_external_id column not yet present — skipping (apply migration 058)");
      return { scanned: 0, upserted: 0, errors: 0 };
    }
    log("outbound: draft query error:", draftsErr.message);
    return { scanned: 0, upserted: 0, errors: 1 };
  }

  if (!drafts?.length) return { scanned: 0, upserted: 0, errors: 0 };

  // Find which already have newsletter_sends rows
  const ids = drafts.map((d) => d.delivery_external_id).filter(Boolean);
  const { data: existing } = await sb
    .from("newsletter_sends")
    .select("campaign_id")
    .in("campaign_id", ids);
  const have = new Set((existing ?? []).map((r) => r.campaign_id));

  const todo = drafts.filter((d) => d.delivery_external_id && !have.has(d.delivery_external_id));
  if (!todo.length) return { scanned: drafts.length, upserted: 0, errors: 0 };

  let upserted = 0;
  let errors = 0;

  for (const draft of todo) {
    try {
      const fetched = (await client().emails.get(draft.delivery_external_id!)) as unknown as {
        data?: Record<string, unknown>;
      };
      const e = fetched.data;
      if (!e) continue;
      const recipientCount = Array.isArray(e.to) ? (e.to as unknown[]).length : e.to ? 1 : null;
      const sentAt = (e.created_at as string) ?? draft.sent_at ?? new Date().toISOString();

      const { error: upErr } = await sb.from("newsletter_sends").upsert(
        {
          draft_slug: draft.slug ?? "unknown",
          delivery_system: "resend",
          campaign_id: draft.delivery_external_id,
          subject: (e.subject as string) ?? draft.subject ?? null,
          sent_at: sentAt,
          recipient_count: recipientCount,
          raw_stats: { source: "pa-actions resend-poll", ...e },
        },
        { onConflict: "draft_slug,campaign_id", ignoreDuplicates: true },
      );

      if (upErr) {
        if (upErr.code === "42P01") {
          log("newsletter_sends table missing — skipping");
          break;
        }
        log("newsletter_sends upsert err:", upErr.message);
        errors++;
      } else {
        upserted++;
      }
    } catch (err) {
      log("resend get failed for", draft.delivery_external_id, ":", err instanceof Error ? err.message : String(err));
      errors++;
    }
  }

  return { scanned: drafts.length, upserted, errors };
}

interface InboundResult {
  scanned: number;
  stored: number;
  forwarded: number;
  errors: number;
}

/**
 * Inbound poll. Resend's receiving API is fetched directly (the SDK exposes
 * `emails.receiving.get(id)` but listing is via the REST endpoint).
 */
async function pollInbound(): Promise<InboundResult> {
  const sb = supabase();
  const lastSeen = await getCursor("resend-poll", "last_received_id");
  const apiKey = env("RESEND_API_KEY");

  let listResp: Response;
  try {
    listResp = await fetch("https://api.resend.com/emails/receiving?limit=50", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    log("inbound list fetch failed:", err instanceof Error ? err.message : String(err));
    return { scanned: 0, stored: 0, forwarded: 0, errors: 1 };
  }

  if (!listResp.ok) {
    // 404 means the endpoint doesn't exist on this account/plan — fail soft.
    if (listResp.status === 404) {
      log("inbound list 404 — receiving API not available; skipping inbound");
      return { scanned: 0, stored: 0, forwarded: 0, errors: 0 };
    }
    log(`inbound list HTTP ${listResp.status}`);
    return { scanned: 0, stored: 0, forwarded: 0, errors: 1 };
  }

  const body = (await listResp.json()) as { data?: Array<{ id: string; created_at?: string }> };
  const items = body.data ?? [];
  if (!items.length) return { scanned: 0, stored: 0, forwarded: 0, errors: 0 };

  // Items are typically newest-first. Process oldest-first so cursor is
  // stable on partial failures.
  const ordered = [...items].reverse();
  let stored = 0;
  let forwarded = 0;
  let errors = 0;
  let newestSeen: string | null = null;

  for (const item of ordered) {
    if (lastSeen && item.id === lastSeen) continue;
    try {
      const fullResp = await fetch(`https://api.resend.com/emails/receiving/${item.id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!fullResp.ok) {
        errors++;
        continue;
      }
      const full = (await fullResp.json()) as Record<string, unknown>;
      const headers = (full.headers ?? {}) as Record<string, string>;
      const inReplyTo = headers["in-reply-to"] ?? headers["In-Reply-To"] ?? null;
      const messageId =
        headers["message-id"] ?? headers["Message-ID"] ?? (full.message_id as string) ?? item.id;
      const from = (full.from as string) ?? "";
      const to = (full.to as string[] | undefined) ?? [];
      const subject = (full.subject as string) ?? "(no subject)";

      const isAutomated = AUTOMATED_FROM_RE.test(from) || AUTOMATED_SUBJECT_RE.test(subject);
      const triageCategory = isAutomated ? "fyi" : "action_needed";
      const triageReason = isAutomated
        ? "Automated/DMARC/bounce notification (getroyalti.com inbound)"
        : "Inbound reply to cold outbound (getroyalti.com)";

      if (!isAutomated) {
        // Check if this message_id already exists. The forwarding step is
        // *not* idempotent (Resend send creates a new outbound email each
        // call), so we must avoid double-firing on cursor races.
        const { data: existing } = await sb
          .from("email_messages")
          .select("id")
          .eq("message_id", messageId)
          .maybeSingle();

        const { error: upErr } = await sb.from("email_messages").upsert(
          {
            message_id: messageId,
            inbox_source: "resend-inbound",
            subject,
            from_address: from,
            to_address: to.join(", "),
            body_text: (full.text as string) ?? null,
            body_html: (full.html as string) ?? null,
            in_reply_to: inReplyTo,
            triage_category: triageCategory,
            triage_reason: triageReason,
            received_at: (full.created_at as string) ?? new Date().toISOString(),
            processed_at: new Date().toISOString(),
          },
          { onConflict: "message_id" },
        );
        if (upErr) {
          log("email_messages upsert err:", upErr.message);
          errors++;
        } else {
          stored++;
        }

        if (existing) {
          // Already had this row from a prior poll — skip forwarding.
          newestSeen = item.id;
          continue;
        }

        // Forward to personal inbox (mirror old webhook behavior)
        try {
          const banner = `<div style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-family:sans-serif;font-size:14px;color:#374151;"><div style="font-weight:600;margin-bottom:8px;">📨 Inbound Reply — getroyalti.com</div><div>From: ${from}<br>To: ${to.join(", ")}<br>Subject: ${subject}</div></div><hr>`;
          const forwardBody =
            (full.html as string)
              ? banner + (full.html as string)
              : banner + `<p>${(full.text as string) ?? "No content available"}</p>`;
          await client().emails.send({
            from: FROM_FORWARD,
            to: [FORWARD_TO],
            subject: `Fwd: ${subject}`,
            html: forwardBody,
            replyTo: [from],
          });
          forwarded++;
        } catch (err) {
          log("forward failed:", err instanceof Error ? err.message : String(err));
        }
      }

      newestSeen = item.id;
    } catch (err) {
      log("inbound item err:", err instanceof Error ? err.message : String(err));
      errors++;
    }
  }

  if (newestSeen) await setCursor("resend-poll", "last_received_id", newestSeen);
  return { scanned: items.length, stored, forwarded, errors };
}

export async function runResendPoll(): Promise<{ outbound: OutboundCatchupResult; inbound: InboundResult }> {
  const outbound = await pollOutboundDeliveries();
  const inbound = await pollInbound();
  log(
    `resend-poll: outbound scanned=${outbound.scanned} upserted=${outbound.upserted} errors=${outbound.errors}; inbound scanned=${inbound.scanned} stored=${inbound.stored} forwarded=${inbound.forwarded} errors=${inbound.errors}`,
  );
  return { outbound, inbound };
}
