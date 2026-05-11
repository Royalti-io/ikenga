//! Tauri commands for user-level activity-bar pinning.
//!
//! Two domains:
//!
//!   * **Sections** — free-form user-created groups of pins. The id is a
//!     slug (lowercase, kebab-cased) chosen at create time; the label is
//!     the display string. Reserved ids (`system`, `settings`) are
//!     host-owned and rejected here.
//!
//!   * **Pins** — user pins of artifacts, routes, files, external URLs, or
//!     pkg-owned routes. A pin may belong to a section (by id) or sit
//!     section-less (`section_id = NULL`). Reorder is per-section: passing
//!     the empty string as `section_id` means "no section".
//!
//! Both tables live in `pa.db` (migration 0010). Mutations go through the
//! shared `PaDb` pool; the schema migration is also embedded in
//! `commands/db.rs::ensure_schema` so fresh installs and dev pools both
//! see the schema.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use super::db::PaDb;

const RESERVED_SECTION_IDS: &[&str] = &["system", "settings"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    pub id: String,
    pub label: String,
    #[serde(rename = "iconLucide")]
    pub icon_lucide: Option<String>,
    #[serde(rename = "iconEmoji")]
    pub icon_emoji: Option<String>,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pin {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub label: String,
    #[serde(rename = "iconLucide")]
    pub icon_lucide: Option<String>,
    #[serde(rename = "iconEmoji")]
    pub icon_emoji: Option<String>,
    #[serde(rename = "sectionId")]
    pub section_id: Option<String>,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

const VALID_PIN_KINDS: &[&str] = &["artifact", "route", "file", "external", "pkg-route"];

fn validate_pin_kind(kind: &str) -> Result<(), String> {
    if VALID_PIN_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!(
            "invalid pin kind '{kind}' (expected one of: {})",
            VALID_PIN_KINDS.join(", ")
        ))
    }
}

fn validate_section_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("section id cannot be empty".into());
    }
    if RESERVED_SECTION_IDS.contains(&trimmed) {
        return Err(format!("'{trimmed}' is a reserved section id"));
    }
    // Sections accept lowercase letters, digits, '-', '_'. Tighter than the
    // free-form label; ids are used in URLs / iyke routes elsewhere so we
    // keep them shell-safe.
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(format!(
            "section id '{trimmed}' must be lowercase ascii [a-z0-9_-]"
        ));
    }
    Ok(())
}

// ─── Sections ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn activity_sections_list(db: State<'_, Arc<PaDb>>) -> Result<Vec<Section>, String> {
    let pool = db.ensure_pool().await?;
    let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>, i64, String)>(
        "SELECT id, label, icon_lucide, icon_emoji, sort_order, created_at \
         FROM activity_bar_sections \
         ORDER BY sort_order ASC, created_at ASC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("query sections: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(id, label, icon_lucide, icon_emoji, sort_order, created_at)| Section {
            id,
            label,
            icon_lucide,
            icon_emoji,
            sort_order,
            created_at,
        })
        .collect())
}

#[tauri::command]
pub async fn activity_sections_create(
    db: State<'_, Arc<PaDb>>,
    id: String,
    label: String,
    icon_lucide: Option<String>,
    icon_emoji: Option<String>,
) -> Result<Section, String> {
    validate_section_id(&id)?;
    let label_trim = label.trim();
    if label_trim.is_empty() {
        return Err("label cannot be empty".into());
    }

    let pool = db.ensure_pool().await?;
    // Place new section at the end.
    let next_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM activity_bar_sections")
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("next sort_order: {e}"))?;
    sqlx::query(
        "INSERT INTO activity_bar_sections (id, label, icon_lucide, icon_emoji, sort_order) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(label_trim)
    .bind(icon_lucide.as_deref())
    .bind(icon_emoji.as_deref())
    .bind(next_order)
    .execute(&pool)
    .await
    .map_err(|e| format!("insert section: {e}"))?;

    let row = sqlx::query_as::<_, (String, String, Option<String>, Option<String>, i64, String)>(
        "SELECT id, label, icon_lucide, icon_emoji, sort_order, created_at \
         FROM activity_bar_sections WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("read back section: {e}"))?;
    Ok(Section {
        id: row.0,
        label: row.1,
        icon_lucide: row.2,
        icon_emoji: row.3,
        sort_order: row.4,
        created_at: row.5,
    })
}

#[tauri::command]
pub async fn activity_sections_update(
    db: State<'_, Arc<PaDb>>,
    id: String,
    label: Option<String>,
    icon_lucide: Option<Option<String>>,
    icon_emoji: Option<Option<String>>,
) -> Result<Section, String> {
    validate_section_id(&id)?;
    let pool = db.ensure_pool().await?;

    if let Some(l) = &label {
        let trimmed = l.trim();
        if trimmed.is_empty() {
            return Err("label cannot be empty".into());
        }
        sqlx::query("UPDATE activity_bar_sections SET label = ? WHERE id = ?")
            .bind(trimmed)
            .bind(&id)
            .execute(&pool)
            .await
            .map_err(|e| format!("update label: {e}"))?;
    }
    if let Some(v) = icon_lucide {
        sqlx::query("UPDATE activity_bar_sections SET icon_lucide = ? WHERE id = ?")
            .bind(v.as_deref())
            .bind(&id)
            .execute(&pool)
            .await
            .map_err(|e| format!("update icon_lucide: {e}"))?;
    }
    if let Some(v) = icon_emoji {
        sqlx::query("UPDATE activity_bar_sections SET icon_emoji = ? WHERE id = ?")
            .bind(v.as_deref())
            .bind(&id)
            .execute(&pool)
            .await
            .map_err(|e| format!("update icon_emoji: {e}"))?;
    }

    let row = sqlx::query_as::<_, (String, String, Option<String>, Option<String>, i64, String)>(
        "SELECT id, label, icon_lucide, icon_emoji, sort_order, created_at \
         FROM activity_bar_sections WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("read back section: {e}"))?;
    Ok(Section {
        id: row.0,
        label: row.1,
        icon_lucide: row.2,
        icon_emoji: row.3,
        sort_order: row.4,
        created_at: row.5,
    })
}

#[tauri::command]
pub async fn activity_sections_remove(
    db: State<'_, Arc<PaDb>>,
    id: String,
) -> Result<(), String> {
    validate_section_id(&id)?;
    let pool = db.ensure_pool().await?;
    // ON DELETE SET NULL on activity_bar_pins.section_id re-parents pins.
    sqlx::query("DELETE FROM activity_bar_sections WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| format!("delete section: {e}"))?;
    Ok(())
}

// ─── Pins ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn activity_pins_list(db: State<'_, Arc<PaDb>>) -> Result<Vec<Pin>, String> {
    let pool = db.ensure_pool().await?;
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            String,
        ),
    >(
        "SELECT id, kind, target, label, icon_lucide, icon_emoji, section_id, sort_order, created_at \
         FROM activity_bar_pins \
         ORDER BY section_id IS NULL, section_id ASC, sort_order ASC, created_at ASC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("query pins: {e}"))?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                kind,
                target,
                label,
                icon_lucide,
                icon_emoji,
                section_id,
                sort_order,
                created_at,
            )| Pin {
                id,
                kind,
                target,
                label,
                icon_lucide,
                icon_emoji,
                section_id,
                sort_order,
                created_at,
            },
        )
        .collect())
}

#[tauri::command]
pub async fn activity_pins_add(
    db: State<'_, Arc<PaDb>>,
    kind: String,
    target: String,
    label: String,
    icon_lucide: Option<String>,
    icon_emoji: Option<String>,
    section_id: Option<String>,
) -> Result<Pin, String> {
    validate_pin_kind(&kind)?;
    if target.trim().is_empty() {
        return Err("target cannot be empty".into());
    }
    let label_trim = label.trim();
    if label_trim.is_empty() {
        return Err("label cannot be empty".into());
    }
    if let Some(sid) = &section_id {
        validate_section_id(sid)?;
    }

    let pool = db.ensure_pool().await?;

    // Reject pins that point at sections that don't exist. This matches the
    // FE flow (host prompts user to create a section first).
    if let Some(sid) = &section_id {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM activity_bar_sections WHERE id = ?")
                .bind(sid)
                .fetch_optional(&pool)
                .await
                .map_err(|e| format!("section lookup: {e}"))?;
        if exists.is_none() {
            return Err(format!("section '{sid}' does not exist"));
        }
    }

    // Place new pin at the end of its section.
    let next_order: i64 = match &section_id {
        Some(sid) => sqlx::query_scalar(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM activity_bar_pins WHERE section_id = ?",
        )
        .bind(sid)
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("next sort_order: {e}"))?,
        None => sqlx::query_scalar(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM activity_bar_pins WHERE section_id IS NULL",
        )
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("next sort_order: {e}"))?,
    };

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO activity_bar_pins \
         (id, kind, target, label, icon_lucide, icon_emoji, section_id, sort_order) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&kind)
    .bind(target.trim())
    .bind(label_trim)
    .bind(icon_lucide.as_deref())
    .bind(icon_emoji.as_deref())
    .bind(section_id.as_deref())
    .bind(next_order)
    .execute(&pool)
    .await
    .map_err(|e| format!("insert pin: {e}"))?;

    let row = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            String,
        ),
    >(
        "SELECT id, kind, target, label, icon_lucide, icon_emoji, section_id, sort_order, created_at \
         FROM activity_bar_pins WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("read back pin: {e}"))?;
    Ok(Pin {
        id: row.0,
        kind: row.1,
        target: row.2,
        label: row.3,
        icon_lucide: row.4,
        icon_emoji: row.5,
        section_id: row.6,
        sort_order: row.7,
        created_at: row.8,
    })
}

#[tauri::command]
pub async fn activity_pins_remove(db: State<'_, Arc<PaDb>>, id: String) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    sqlx::query("DELETE FROM activity_bar_pins WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| format!("delete pin: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn activity_pins_reorder(
    db: State<'_, Arc<PaDb>>,
    ordered_ids: Vec<String>,
    section_id: String,
) -> Result<(), String> {
    let pool = db.ensure_pool().await?;
    // section_id "" sentinel means "no section" (NULL in SQL).
    let target_section: Option<&str> = if section_id.is_empty() {
        None
    } else {
        validate_section_id(&section_id)?;
        Some(section_id.as_str())
    };

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin tx: {e}"))?;
    for (idx, pin_id) in ordered_ids.iter().enumerate() {
        let res = match target_section {
            Some(sid) => {
                sqlx::query(
                    "UPDATE activity_bar_pins SET sort_order = ?, section_id = ? \
                     WHERE id = ?",
                )
                .bind(idx as i64)
                .bind(sid)
                .bind(pin_id)
                .execute(&mut *tx)
                .await
            }
            None => {
                sqlx::query(
                    "UPDATE activity_bar_pins SET sort_order = ?, section_id = NULL \
                     WHERE id = ?",
                )
                .bind(idx as i64)
                .bind(pin_id)
                .execute(&mut *tx)
                .await
            }
        };
        res.map_err(|e| format!("reorder pin {pin_id}: {e}"))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("commit reorder: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_reserved_section_ids() {
        assert!(validate_section_id("system").is_err());
        assert!(validate_section_id("settings").is_err());
    }

    #[test]
    fn rejects_empty_section_id() {
        assert!(validate_section_id("").is_err());
        assert!(validate_section_id("   ").is_err());
    }

    #[test]
    fn rejects_invalid_chars() {
        assert!(validate_section_id("Finance").is_err());
        assert!(validate_section_id("my section").is_err());
        assert!(validate_section_id("foo/bar").is_err());
    }

    #[test]
    fn accepts_valid_section_ids() {
        assert!(validate_section_id("finance").is_ok());
        assert!(validate_section_id("my-section").is_ok());
        assert!(validate_section_id("custom_2").is_ok());
    }

    #[test]
    fn validates_pin_kinds() {
        assert!(validate_pin_kind("artifact").is_ok());
        assert!(validate_pin_kind("route").is_ok());
        assert!(validate_pin_kind("file").is_ok());
        assert!(validate_pin_kind("external").is_ok());
        assert!(validate_pin_kind("pkg-route").is_ok());
        assert!(validate_pin_kind("bogus").is_err());
        assert!(validate_pin_kind("").is_err());
    }
}
