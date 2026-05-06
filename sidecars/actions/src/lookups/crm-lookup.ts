/**
 * CRM lookup — Reply Intelligence panel data source.
 *
 * Returns a structured payload for one email address, drawn from:
 *   - Twenty CRM (people + companies + opportunities) via REST
 *   - email_drafts (last touch, sequence membership) via Supabase
 *
 * Cells the design wants but we don't have local sources for yet
 * (tenant id, catalog stats, open balance, health) come back as `null`.
 * The frontend renders an em-dash for null cells — honest about gaps.
 *
 * Returns `null` when the email has no Twenty CRM record AND no
 * email_drafts touchpoints; the panel collapses to the "Unknown sender"
 * empty state.
 */

import { supabase } from "../lib/supabase";
import { envOptional } from "../lib/env";
import { log } from "../lib/output";
import { lookupTenantByEmail } from "../lib/royalti-db";

interface TwentyPerson {
  id: string;
  name?: { firstName?: string; lastName?: string };
  emails?: { primaryEmail?: string };
  jobTitle?: string;
  companyId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface TwentyCompany {
  id: string;
  name?: string;
  domainName?: { primaryLinkUrl?: string };
}

export interface CrmLookupResult {
  email: string;
  // Tenant / org cell — only populated when Twenty CRM has a company.
  tenant: { id: string; name: string; sub: string | null } | null;
  // Last touch — most recent email_draft to/from this address that's been sent.
  last_touch: { at: string; subject: string; direction: "out" | "in" } | null;
  // Health — placeholder; needs Royalti prod DB access (cross-DB, deferred).
  health: { label: string; tone: "ok" | "warn" | "danger"; sub: string | null } | null;
  // Sequence — derived from email_drafts.sequence_id grouped to the latest one.
  sequence: { id: string; name: string; step: number | null; total: number | null } | null;
  // Catalog / open balance / risk — Royalti prod DB (deferred).
  catalog: { products: number; tracks: number; sub: string | null } | null;
  open_balance: { amount_usd: number; sub: string | null } | null;
  // Owner — Twenty CRM person assignee. Falls back to created_by chip on the draft.
  owner: { name: string; sub: string | null } | null;
  risk_flag: { label: string; tone: "ok" | "warn" | "danger"; sub: string | null } | null;
  // True when Twenty had a hit; the frontend uses this to choose between
  // the full panel and the "Unknown sender · create contact" empty state.
  in_crm: boolean;
}

export async function crmLookup(args: string[]): Promise<CrmLookupResult | null> {
  const email = args[0];
  if (!email) {
    throw new Error("crm-lookup requires an email address as the first arg");
  }
  const normalised = email.trim().toLowerCase();

  // Run Twenty + last-touch + sequence + prod-DB tenant snapshot in parallel.
  const [person, lastTouch, sequence, royalti] = await Promise.all([
    fetchTwentyPerson(normalised),
    fetchLastTouch(normalised),
    fetchLatestSequence(normalised),
    lookupTenantByEmail(normalised),
  ]);

  if (!person && !lastTouch && !sequence && !royalti) {
    return null;
  }

  // Tenant: prefer Royalti prod (canonical) over Twenty CRM company name.
  // Twenty often has a sales-side company that doesn't match the actual
  // tenant id — Royalti's tenants table is the source of truth.
  let tenant: CrmLookupResult["tenant"] = null;
  if (royalti?.tenant) {
    const planSub = royalti.tenant.plan_code
      ? `id ${royalti.tenant.id} · plan ${royalti.tenant.plan_code}`
      : `id ${royalti.tenant.id}`;
    tenant = {
      id: String(royalti.tenant.id),
      name: royalti.tenant.name,
      sub: planSub,
    };
  } else if (person?.companyId) {
    const company = await fetchTwentyCompany(person.companyId);
    if (company) {
      tenant = {
        id: company.id,
        name: company.name ?? "—",
        sub: company.domainName?.primaryLinkUrl ?? null,
      };
    }
  }

  // Owner: Royalti TenantUser (firstName + lastName + role) wins over the
  // Twenty CRM person — Royalti is who actually pays / runs the workspace.
  let owner: CrmLookupResult["owner"] = null;
  if (royalti?.owner) {
    owner = { name: royalti.owner.name, sub: `tenant ${royalti.owner.role}` };
  } else if (person) {
    const ownerName =
      [person.name?.firstName, person.name?.lastName].filter(Boolean).join(" ") || "—";
    owner = { name: ownerName, sub: person.jobTitle ?? null };
  }

  // Health: derive from Users.updatedAt — best signal we have without
  // a dedicated lastLoginAt column. <14d Active, <60d Recent, else Idle.
  const health = healthFromActivity(royalti?.last_user_activity_at ?? null);

  // Catalog: real counts from Products + ReleaseAssets.
  const catalog = royalti?.catalog
    ? {
        products: royalti.catalog.products,
        tracks: royalti.catalog.tracks,
        sub: royalti.catalog.last_file_at
          ? `last ingest ${shortDate(royalti.catalog.last_file_at)}`
          : "no statements ingested",
      }
    : null;

  return {
    email: normalised,
    tenant,
    last_touch: lastTouch,
    health,
    sequence,
    catalog,
    // Open balance + risk flag still need schema work the design assumes
    // exists (Billing rollups, support ticket joins). Leave null so the
    // frontend renders an em-dash with the existing 'requires Royalti DB'
    // hint — honest about the next gap.
    open_balance: null,
    owner,
    risk_flag: null,
    in_crm: !!person,
  };
}

function healthFromActivity(
  updatedAt: string | null,
): CrmLookupResult["health"] {
  if (!updatedAt) return null;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 14) {
    return { label: "Active", tone: "ok", sub: `last touch ${days}d ago` };
  }
  if (days <= 60) {
    return { label: `Recent · ${days}d`, tone: "ok", sub: "still warm" };
  }
  return { label: `Idle ${days}d`, tone: "warn", sub: shortDate(updatedAt) };
}

function shortDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

async function fetchTwentyPerson(email: string): Promise<TwentyPerson | null> {
  const apiUrl = envOptional("TWENTY_API_URL");
  const apiKey = envOptional("TWENTY_API_KEY");
  if (!apiUrl || !apiKey) {
    log("crm-lookup: TWENTY_API_URL / TWENTY_API_KEY missing, skipping CRM");
    return null;
  }
  const url = `${apiUrl.replace(/\/$/, "")}/rest/people?filter=emails.primaryEmail[eq]:${encodeURIComponent(email)}&limit=1`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!resp.ok) {
      log(`crm-lookup: twenty HTTP ${resp.status} for ${email}`);
      return null;
    }
    const body = (await resp.json()) as { data?: { people?: TwentyPerson[] } };
    return body.data?.people?.[0] ?? null;
  } catch (err) {
    log("crm-lookup twenty fetch failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchTwentyCompany(id: string): Promise<TwentyCompany | null> {
  const apiUrl = envOptional("TWENTY_API_URL");
  const apiKey = envOptional("TWENTY_API_KEY");
  if (!apiUrl || !apiKey) return null;
  const url = `${apiUrl.replace(/\/$/, "")}/rest/companies/${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: { company?: TwentyCompany } };
    return body.data?.company ?? null;
  } catch {
    return null;
  }
}

async function fetchLastTouch(
  email: string,
): Promise<CrmLookupResult["last_touch"]> {
  const sb = supabase();
  // recipients is JSONB array of {email,...} — Supabase contains() works on
  // JSONB. Try outbound first (we sent to them), then inbound (they replied,
  // currently tracked in email_replies).
  const { data: outRows } = await sb
    .from("email_drafts")
    .select("subject, sent_at")
    .eq("status", "sent")
    .contains("recipients", [{ email }])
    .order("sent_at", { ascending: false })
    .limit(1);
  if (outRows && outRows.length > 0 && outRows[0]!.sent_at) {
    return {
      at: outRows[0]!.sent_at as string,
      subject: (outRows[0]!.subject as string) ?? "",
      direction: "out",
    };
  }
  return null;
}

async function fetchLatestSequence(
  email: string,
): Promise<CrmLookupResult["sequence"]> {
  const sb = supabase();
  const { data } = await sb
    .from("email_drafts")
    .select(
      "sequence_id, sequence_step, sequence:email_sequences(name, total_steps)",
    )
    .contains("recipients", [{ email }])
    .not("sequence_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0] as
    | {
        sequence_id: string;
        sequence_step: number | null;
        sequence: { name: string; total_steps: number } | null;
      }
    | undefined;
  if (!row || !row.sequence_id) return null;
  return {
    id: row.sequence_id,
    name: row.sequence?.name ?? "—",
    step: row.sequence_step,
    total: row.sequence?.total_steps ?? null,
  };
}
