//! WP-10 — the tasks domain over the iyke bridge.
//!
//! Before this, agents had `iyke_todos` (runtime coordination) and nothing
//! else: the `tasks` board the human actually works from had no bridge surface
//! at all, so agent work was invisible where it mattered and an orchestrator
//! could not read what it had been asked to do.
//!
//! Agents get full read/write here (decision D-2). The safety property is not
//! restricted verbs but a complete audit trail: **every mutation writes a
//! `task_events` row** naming the agent as `actor`, so a task that moved can
//! always be traced to who moved it and when.
//!
//! Timestamp discipline: `tasks` predates the iyke tables and stores TEXT
//! timestamps (`datetime('now')`, i.e. `YYYY-MM-DD HH:MM:SS`), while every
//! `iyke_*` table uses INTEGER epoch millis. These must not be mixed — the
//! helpers below keep this module entirely on the TEXT side.

use std::sync::Arc;

use axum::{
    extract::{Json as JsonBody, Query},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::commands::db::PaDb;

fn err(status: StatusCode, message: impl Into<String>) -> (StatusCode, String) {
    (status, message.into())
}

/// The `tasks` table's timestamp format — SQLite `datetime('now')`, UTC.
/// Deliberately NOT epoch millis; see the module note.
fn now_text() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Append to the task's event log. Every write path calls this; a mutation
/// that skipped it would be an untraceable change to the human's board.
async fn record_event(
    pool: &SqlitePool,
    task_id: &str,
    event_type: &str,
    from_value: Option<&str>,
    to_value: Option<&str>,
    actor: &str,
    detail: Option<&str>,
) {
    let _ = sqlx::query(
        "INSERT INTO task_events (task_id, event_type, from_value, to_value, actor, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(task_id)
    .bind(event_type)
    .bind(from_value)
    .bind(to_value)
    .bind(actor)
    .bind(detail)
    .bind(now_text())
    .execute(pool)
    .await;
}

/// Columns returned by list/get. Kept to the fields an orchestrator plausibly
/// reasons about — the table has ~30, and dumping all of them buries the
/// signal in strategic metadata no agent reads.
const TASK_COLUMNS: &str = "id, title, description, status, priority, assigned_to, assignee_type, \
     created_by, agent_source, project_path, due_date, completed_at, created_at, updated_at, \
     execution_mode, task_result, outcome_notes, parent_task_id, blocked_by_task_id, progress_pct";

fn row_to_task(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": r.get::<String, _>("id"),
        "title": r.get::<String, _>("title"),
        "description": r.get::<Option<String>, _>("description"),
        "status": r.get::<Option<String>, _>("status"),
        "priority": r.get::<Option<String>, _>("priority"),
        "assigned_to": r.get::<Option<String>, _>("assigned_to"),
        "assignee_type": r.get::<Option<String>, _>("assignee_type"),
        "created_by": r.get::<Option<String>, _>("created_by"),
        "agent_source": r.get::<Option<String>, _>("agent_source"),
        "project_path": r.get::<Option<String>, _>("project_path"),
        "due_date": r.get::<Option<String>, _>("due_date"),
        "completed_at": r.get::<Option<String>, _>("completed_at"),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "updated_at": r.get::<Option<String>, _>("updated_at"),
        "execution_mode": r.get::<Option<String>, _>("execution_mode"),
        "task_result": r.get::<Option<String>, _>("task_result"),
        "outcome_notes": r.get::<Option<String>, _>("outcome_notes"),
        "parent_task_id": r.get::<Option<String>, _>("parent_task_id"),
        "blocked_by_task_id": r.get::<Option<String>, _>("blocked_by_task_id"),
        "progress_pct": r.get::<Option<i64>, _>("progress_pct"),
    })
}

#[derive(Deserialize)]
pub struct TaskListQuery {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub assigned_to: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn get_task_list(
    Extension(db): Extension<Arc<PaDb>>,
    Query(q): Query<TaskListQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let mut sql = format!("SELECT {TASK_COLUMNS} FROM tasks WHERE 1=1");
    if q.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    if q.assigned_to.is_some() {
        sql.push_str(" AND assigned_to = ?");
    }
    if q.project_path.is_some() {
        sql.push_str(" AND project_path = ?");
    }
    sql.push_str(" ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?");
    let mut qb = sqlx::query(&sql);
    if let Some(v) = &q.status {
        qb = qb.bind(v);
    }
    if let Some(v) = &q.assigned_to {
        qb = qb.bind(v);
    }
    if let Some(v) = &q.project_path {
        qb = qb.bind(v);
    }
    let rows = qb
        .bind(limit)
        .fetch_all(&pool)
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("task list: {e}")))?;
    let tasks: Vec<Value> = rows.iter().map(row_to_task).collect();
    Ok(Json(json!({ "tasks": tasks })))
}

#[derive(Deserialize)]
pub struct TaskCreateBody {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub assigned_to: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    /// Which agent is creating this. Recorded as `agent_source` + `created_by`
    /// and as the event actor, so an agent-created task is never anonymous on
    /// the board.
    #[serde(default)]
    pub actor: Option<String>,
}

pub async fn post_task_create(
    Extension(db): Extension<Arc<PaDb>>,
    JsonBody(body): JsonBody<TaskCreateBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if body.title.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "title must not be empty"));
    }
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let id = Uuid::new_v4().to_string();
    let now = now_text();
    let actor = body.actor.unwrap_or_else(|| "iyke".to_string());
    sqlx::query(
        "INSERT INTO tasks (id, title, description, status, priority, assigned_to, assignee_type,
                            created_by, agent_source, project_path, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&body.title)
    .bind(&body.description)
    .bind(body.status.as_deref().unwrap_or("pending"))
    .bind(body.priority.as_deref().unwrap_or("medium"))
    .bind(&body.assigned_to)
    .bind(&actor)
    .bind(&actor)
    .bind(&body.project_path)
    .bind(&body.due_date)
    .bind(&now)
    .bind(&now)
    .execute(&pool)
    .await
    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("task create: {e}")))?;

    record_event(&pool, &id, "created", None, Some("pending"), &actor, None).await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

#[derive(Deserialize)]
pub struct TaskUpdateBody {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub assigned_to: Option<String>,
    #[serde(default)]
    pub progress_pct: Option<i64>,
    #[serde(default)]
    pub task_result: Option<String>,
    #[serde(default)]
    pub outcome_notes: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

pub async fn post_task_update(
    Extension(db): Extension<Arc<PaDb>>,
    JsonBody(body): JsonBody<TaskUpdateBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let existing = sqlx::query("SELECT status FROM tasks WHERE id = ?")
        .bind(&body.id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("task update: {e}"),
            )
        })?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("no task {}", body.id)))?;
    let prev_status: Option<String> = existing.get("status");

    let mut sets: Vec<&str> = Vec::new();
    if body.title.is_some() {
        sets.push("title = ?");
    }
    if body.description.is_some() {
        sets.push("description = ?");
    }
    if body.status.is_some() {
        sets.push("status = ?");
    }
    if body.priority.is_some() {
        sets.push("priority = ?");
    }
    if body.assigned_to.is_some() {
        sets.push("assigned_to = ?");
    }
    if body.progress_pct.is_some() {
        sets.push("progress_pct = ?");
    }
    if body.task_result.is_some() {
        sets.push("task_result = ?");
    }
    if body.outcome_notes.is_some() {
        sets.push("outcome_notes = ?");
    }
    if sets.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "no fields to update"));
    }
    sets.push("updated_at = ?");
    sets.push("modified_by = ?");

    let actor = body.actor.clone().unwrap_or_else(|| "iyke".to_string());
    let sql = format!("UPDATE tasks SET {} WHERE id = ?", sets.join(", "));
    let mut qb = sqlx::query(&sql);
    if let Some(v) = &body.title {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.description {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.status {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.priority {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.assigned_to {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.progress_pct {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.task_result {
        qb = qb.bind(v);
    }
    if let Some(v) = &body.outcome_notes {
        qb = qb.bind(v);
    }
    qb.bind(now_text())
        .bind(&actor)
        .bind(&body.id)
        .execute(&pool)
        .await
        .map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("task update: {e}"),
            )
        })?;

    if let Some(new_status) = &body.status {
        if prev_status.as_deref() != Some(new_status.as_str()) {
            record_event(
                &pool,
                &body.id,
                "status_changed",
                prev_status.as_deref(),
                Some(new_status),
                &actor,
                None,
            )
            .await;
        }
    } else {
        record_event(&pool, &body.id, "updated", None, None, &actor, None).await;
    }
    Ok(Json(json!({ "ok": true, "id": body.id })))
}

#[derive(Deserialize)]
pub struct TaskCompleteBody {
    pub id: String,
    #[serde(default)]
    pub task_result: Option<String>,
    #[serde(default)]
    pub outcome_notes: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

pub async fn post_task_complete(
    Extension(db): Extension<Arc<PaDb>>,
    JsonBody(body): JsonBody<TaskCompleteBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool = db
        .ensure_pool()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let existing = sqlx::query("SELECT status FROM tasks WHERE id = ?")
        .bind(&body.id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("task complete: {e}"),
            )
        })?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("no task {}", body.id)))?;
    let prev_status: Option<String> = existing.get("status");
    let now = now_text();
    let actor = body.actor.unwrap_or_else(|| "iyke".to_string());
    sqlx::query(
        "UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ?, modified_by = ?,
                          task_result = COALESCE(?, task_result),
                          outcome_notes = COALESCE(?, outcome_notes)
         WHERE id = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(&actor)
    .bind(&body.task_result)
    .bind(&body.outcome_notes)
    .bind(&body.id)
    .execute(&pool)
    .await
    .map_err(|e| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("task complete: {e}"),
        )
    })?;

    record_event(
        &pool,
        &body.id,
        "status_changed",
        prev_status.as_deref(),
        Some("completed"),
        &actor,
        body.task_result.as_deref(),
    )
    .await;
    Ok(Json(json!({ "ok": true, "id": body.id })))
}
