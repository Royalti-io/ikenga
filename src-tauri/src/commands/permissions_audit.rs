//! Phase 3 of `2026-05-15-runtime-acl-enforcement` — read/clear surface for
//! the `pkg_permission_violations` audit table that Phase 2 writes into.
//!
//! Two commands:
//!   - `pkg_permission_violations_list` — newest-first rows, optionally
//!     filtered by pkg_id. Backs Settings → Pkgs Violations badge + the
//!     Review dialog table.
//!   - `pkg_permission_violations_clear` — deletes the named pkg's rows.
//!     Audit-only — does not alter trust state or re-grant anything.
//!
//! Both go through the same `db: State<Arc<PaDb>>` shape as `commands::trust`.

use std::sync::Arc;

use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::commands::db::PaDb;

#[derive(Serialize, Clone)]
pub struct ViolationRow {
    pub id: i64,
    pub pkg_id: String,
    pub scope_kind: String,
    pub attempted: String,
    pub declared: String,
    pub occurred_at: i64,
}

/// Default row cap — large enough for the Review dialog's "show me the
/// recent attempts" use case, small enough to keep payloads bounded when
/// the FE polls.
const DEFAULT_LIMIT: i64 = 100;
/// Hard ceiling — caps a misbehaving caller from yanking the entire table.
const MAX_LIMIT: i64 = 1000;

#[tauri::command]
pub async fn pkg_permission_violations_list(
    db: State<'_, Arc<PaDb>>,
    pkg_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ViolationRow>, String> {
    let pool = db.ensure_pool().await?;
    let lim = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    let rows = if let Some(id) = pkg_id {
        sqlx::query(
            "SELECT id, pkg_id, scope_kind, attempted, declared, occurred_at
             FROM pkg_permission_violations
             WHERE pkg_id = ?
             ORDER BY occurred_at DESC
             LIMIT ?",
        )
        .bind(&id)
        .bind(lim)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(
            "SELECT id, pkg_id, scope_kind, attempted, declared, occurred_at
             FROM pkg_permission_violations
             ORDER BY occurred_at DESC
             LIMIT ?",
        )
        .bind(lim)
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| format!("query pkg_permission_violations: {e:#}"))?;

    Ok(rows
        .into_iter()
        .map(|r| ViolationRow {
            id: r.get::<i64, _>("id"),
            pkg_id: r.get::<String, _>("pkg_id"),
            scope_kind: r.get::<String, _>("scope_kind"),
            attempted: r.get::<String, _>("attempted"),
            declared: r.get::<String, _>("declared"),
            occurred_at: r.get::<i64, _>("occurred_at"),
        })
        .collect())
}

#[tauri::command]
pub async fn pkg_permission_violations_clear(
    db: State<'_, Arc<PaDb>>,
    pkg_id: String,
) -> Result<u64, String> {
    let pool = db.ensure_pool().await?;
    let result = sqlx::query("DELETE FROM pkg_permission_violations WHERE pkg_id = ?")
        .bind(&pkg_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("delete pkg_permission_violations: {e:#}"))?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg::permissions_check::{record_violation, ShellExecuteDenied};

    /// Bring up an in-memory pool with the violations table, write a few
    /// rows via the Phase 2 writer, and verify the read shape + ordering.
    async fn fresh_pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::query(include_str!(
            "../../migrations/0020_pkg_permission_violations.sql"
        ))
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    #[tokio::test]
    async fn list_returns_newest_first() {
        let pool = fresh_pool().await;
        for cmd in ["a", "b", "c"] {
            record_violation(
                &pool,
                "shell.execute",
                &ShellExecuteDenied {
                    pkg_id: "p".into(),
                    command: cmd.into(),
                    declared: "x".into(),
                },
            )
            .await
            .expect("record");
            // 1 ms gap so occurred_at orders deterministically without
            // relying on insert order.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        let rows = sqlx::query(
            "SELECT id, pkg_id, scope_kind, attempted, declared, occurred_at
             FROM pkg_permission_violations
             ORDER BY occurred_at DESC LIMIT 100",
        )
        .fetch_all(&pool)
        .await
        .expect("read back");
        let attempted: Vec<String> = rows
            .into_iter()
            .map(|r| r.get::<String, _>("attempted"))
            .collect();
        assert_eq!(attempted, vec!["c", "b", "a"]);
    }

    #[tokio::test]
    async fn clear_only_deletes_named_pkg() {
        let pool = fresh_pool().await;
        for pkg in ["p1", "p2", "p1"] {
            record_violation(
                &pool,
                "shell.execute",
                &ShellExecuteDenied {
                    pkg_id: pkg.into(),
                    command: "x".into(),
                    declared: "y".into(),
                },
            )
            .await
            .expect("record");
        }
        let deleted = sqlx::query("DELETE FROM pkg_permission_violations WHERE pkg_id = 'p1'")
            .execute(&pool)
            .await
            .expect("delete")
            .rows_affected();
        assert_eq!(deleted, 2);
        let remaining: i64 =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pkg_permission_violations")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(remaining, 1);
    }
}
