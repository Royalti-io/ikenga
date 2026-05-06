/**
 * Royalti production DB (GCP Cloud SQL) reader.
 *
 * Read-only. Used by crm-lookup to enrich Reply Intelligence with
 * tenant / health / catalog / owner cells the design wants.
 *
 * Connection resolution order:
 *   1. ROYALTI_PG_* env vars (preferred — set by the desktop env-vault).
 *   2. Fallback: read PG_* vars from royalti-server-v2.6/.env on disk.
 *      The existing import scripts (royalti-pa/scripts/import-tenant-*)
 *      already do this; we mirror the path so cron and ad-hoc tooling
 *      work without ceremony.
 *
 * Connection is lazy + singleton — first call opens the pool, subsequent
 * calls reuse it. The sidecar exits after each one-shot run so the pool
 * doesn't outlive the process; in --daemon mode it stays warm.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import postgres, { type Sql } from "postgres";

import { envOptional } from "./env";
import { log } from "./output";

interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let _sql: Sql | null = null;
let _disabled = false;

function readServerEnv(): Partial<PgConfig> {
  const path = resolve(homedir(), "royalti-co", "royalti-server-v2.6", ".env");
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return {
      host: out.PG_HOST,
      port: out.PG_PORT ? Number(out.PG_PORT) : undefined,
      user: out.PG_USERNAME,
      password: out.PG_PASSWORD,
      database: out.PG_DATABASE,
    };
  } catch (err) {
    log("royalti-db: failed reading server .env:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

function resolveConfig(): PgConfig | null {
  const fromEnv = {
    host: envOptional("ROYALTI_PG_HOST"),
    port: envOptional("ROYALTI_PG_PORT"),
    user: envOptional("ROYALTI_PG_USER"),
    password: envOptional("ROYALTI_PG_PASSWORD"),
    database: envOptional("ROYALTI_PG_DATABASE"),
  };
  const fromServer = readServerEnv();

  const host = fromEnv.host ?? fromServer.host;
  const user = fromEnv.user ?? fromServer.user;
  const password = fromEnv.password ?? fromServer.password;
  const database = fromEnv.database ?? fromServer.database;
  const port = fromEnv.port ? Number(fromEnv.port) : fromServer.port ?? 5432;

  if (!host || !user || !password || !database) {
    return null;
  }
  return { host, port, user, password, database };
}

export function royaltiDb(): Sql | null {
  if (_disabled) return null;
  if (_sql) return _sql;
  const cfg = resolveConfig();
  if (!cfg) {
    log("royalti-db: ROYALTI_PG_* unset and royalti-server-v2.6/.env missing — skipping prod-DB enrichment");
    _disabled = true;
    return null;
  }
  _sql = postgres({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 2,
    idle_timeout: 5,
    connect_timeout: 8,
    // Cloud SQL accepts plain TLS or no TLS depending on the public IP
    // config. The existing import scripts use psql without --ssl, so the
    // server allows non-TLS. Keep parity to avoid handshake surprises.
    ssl: false,
  });
  return _sql;
}

export interface RoyaltiTenantSnapshot {
  tenant: { id: number; name: string; plan_code: string | null } | null;
  // Most-recent activity by any user attached to the tenant.
  // Used as a "Health" proxy because Users has no lastLoginAt column —
  // updatedAt is the closest signal we have.
  last_user_activity_at: string | null;
  catalog: {
    products: number;
    tracks: number;
    last_file_at: string | null;
  };
  owner: { name: string; role: string } | null;
}

/**
 * Look up tenant + catalog + recent activity by email address. Joins
 * Users → TenantUsers → Tenants and pulls a count of Products, ReleaseAssets
 * (proxy for tracks), and the most recent royalty file upload.
 *
 * Returns null when the email isn't on a Royalti tenant. All counts are
 * tenant-scoped — if one user belongs to multiple tenants we pick the
 * most recent TenantUser row (createdAt DESC).
 */
export async function lookupTenantByEmail(
  email: string,
): Promise<RoyaltiTenantSnapshot | null> {
  const sql = royaltiDb();
  if (!sql) return null;

  try {
    const rows = await sql<
      Array<{
        tenant_id: number;
        tenant_name: string;
        plan_code: string | null;
        first_name: string | null;
        last_name: string | null;
        role: string;
        last_user_activity_at: string | null;
      }>
    >`
      SELECT
        t.id              AS tenant_id,
        t.name            AS tenant_name,
        ts."PlanCode"     AS plan_code,
        tu."firstName"    AS first_name,
        tu."lastName"     AS last_name,
        tu.role::text     AS role,
        u."updatedAt"     AS last_user_activity_at
      FROM "Users" u
      JOIN "TenantUsers" tu ON tu."UserId" = u.id
      JOIN "Tenants"     t  ON t.id        = tu."TenantId"
      LEFT JOIN LATERAL (
        SELECT "PlanCode"
        FROM "TenantSubscriptions"
        WHERE "TenantId" = t.id
        ORDER BY "createdAt" DESC
        LIMIT 1
      ) ts ON TRUE
      WHERE LOWER(u.email) = LOWER(${email})
      ORDER BY tu."createdAt" DESC
      LIMIT 1
    `;
    const head = rows[0];
    if (!head) return null;

    const [productsRow, tracksRow, lastFileRow] = await Promise.all([
      sql<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM "Products" WHERE "TenantId" = ${head.tenant_id}
      `,
      sql<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM "ReleaseAssets" WHERE "TenantId" = ${head.tenant_id}
      `,
      sql<Array<{ at: string | null }>>`
        SELECT MAX("createdAt") AS at FROM "Files" WHERE "TenantId" = ${head.tenant_id}
      `,
    ]);

    const fullName = [head.first_name, head.last_name].filter(Boolean).join(" ").trim();

    return {
      tenant: {
        id: head.tenant_id,
        name: head.tenant_name,
        plan_code: head.plan_code,
      },
      last_user_activity_at: head.last_user_activity_at,
      catalog: {
        products: productsRow[0]?.c ?? 0,
        tracks: tracksRow[0]?.c ?? 0,
        last_file_at: lastFileRow[0]?.at ?? null,
      },
      owner: fullName ? { name: fullName, role: head.role } : null,
    };
  } catch (err) {
    log("royalti-db: tenant lookup failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
