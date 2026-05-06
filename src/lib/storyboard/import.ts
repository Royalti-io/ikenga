/**
 * One-shot fixture import — pulls existing storyboard.json files from the
 * engine repo into SQLite. Idempotent: replays as upserts so re-running on
 * a populated DB doesn't lose user edits unless the disk file is newer.
 *
 * v1 imports the two compositions registered in @/video/registry:
 *   - ask-roy
 *   - ask-roy-v2
 *
 * Run on first load when storyboards table is empty (see ImportStoryboards
 * effect in routes/storyboard/index.lazy.tsx). Phase 5.1 will hook
 * `storyboard_import_json` to a UI button for ad-hoc imports.
 */

import { dbExec, dbQuery, storyboardImportJson } from "@/lib/tauri-cmd";
import { StoryboardSchema } from "@/video/lib/storyboard-schema";

import { upsertBeat } from "@/lib/queries/storyboard/storyboards";

const FIXTURE_SLUGS = ["ask-roy", "ask-roy-v2"] as const;

export interface ImportReport {
  imported: string[];
  skipped: { slug: string; reason: string }[];
}

export async function ensureFixturesImported(): Promise<ImportReport> {
  const report: ImportReport = { imported: [], skipped: [] };
  const existing = await dbQuery<{ id: string }>(
    `SELECT id FROM storyboards WHERE id IN (?, ?)`,
    [FIXTURE_SLUGS[0], FIXTURE_SLUGS[1]],
  );
  const haveSlug = new Set(existing.map((r) => r.id));

  for (const slug of FIXTURE_SLUGS) {
    if (haveSlug.has(slug)) {
      report.skipped.push({ slug, reason: "already imported" });
      continue;
    }
    try {
      await importFromDisk(slug);
      report.imported.push(slug);
    } catch (e) {
      report.skipped.push({ slug, reason: String(e) });
    }
  }
  return report;
}

export async function importFromDisk(slug: string): Promise<void> {
  const raw = await storyboardImportJson(slug);
  const sb = StoryboardSchema.parse(raw);
  const now = Date.now();

  // Upsert head row.
  await dbExec(
    `INSERT INTO storyboards
       (id, title, source_kind, current_rung, narration, selected_concepts,
        selected_concepts_note, version, created_at, updated_at, exported_at)
     VALUES (?, ?, 'imported', ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title                  = excluded.title,
       current_rung           = excluded.current_rung,
       narration              = excluded.narration,
       selected_concepts      = excluded.selected_concepts,
       selected_concepts_note = excluded.selected_concepts_note,
       updated_at             = excluded.updated_at,
       exported_at            = excluded.exported_at,
       version                = storyboards.version + 1`,
    [
      sb.slug,
      sb.title,
      sb.current_rung,
      sb.narration ? JSON.stringify(sb.narration) : null,
      sb.selected_concepts ? JSON.stringify(sb.selected_concepts) : null,
      sb.selected_concepts_note ?? null,
      now,
      now,
      now,
    ],
  );

  // Upsert beats. Order is preserved as index_in_board.
  for (let i = 0; i < sb.beats.length; i++) {
    await upsertBeat({
      storyboardId: sb.slug,
      beat: sb.beats[i],
      indexInBoard: i,
    });
  }
}
