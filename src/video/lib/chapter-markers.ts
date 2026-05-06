/**
 * Chapter Markers — generates YouTube-compatible chapter timestamps
 * from a Scene[] array.
 *
 * YouTube requires:
 * - First chapter must start at 00:00
 * - At least 3 chapters
 * - Each chapter at least 10 seconds
 *
 * Output format:
 *   00:00 Introduction
 *   00:15 The Problem
 *   01:30 Mechanical Royalties
 */

/** Minimal Scene shape needed for chapter marker generation. */
interface Scene {
  id: string;
  type: string;
  startFrame: number;
  sectionTitle?: string;
}

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export interface ChapterMarker {
  timestamp: string;
  title: string;
  startSeconds: number;
}

/**
 * Generate YouTube chapter markers from scenes.
 * @param scenes - Scene array from scene-builder
 * @param fps - Frames per second (default 30)
 * @returns Array of chapter markers and formatted string
 */
export function generateChapterMarkers(
  scenes: Scene[],
  fps: number = 30,
): { markers: ChapterMarker[]; formatted: string } {
  const markers: ChapterMarker[] = [];

  for (const scene of scenes) {
    const startSeconds = scene.startFrame / fps;
    const title =
      scene.type === "hook"
        ? "Introduction"
        : scene.type === "cta"
          ? "Wrap Up"
          : scene.sectionTitle || scene.id;

    markers.push({
      timestamp: formatTimestamp(startSeconds),
      title,
      startSeconds,
    });
  }

  // Ensure first chapter starts at 00:00
  if (markers.length > 0 && markers[0].startSeconds > 0) {
    markers[0].timestamp = "00:00";
    markers[0].startSeconds = 0;
  }

  const formatted = markers
    .map((m) => `${m.timestamp} ${m.title}`)
    .join("\n");

  return { markers, formatted };
}
