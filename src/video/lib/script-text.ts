export interface PauseMarker {
  type: "beat" | "pause";
  position: number;
}

export interface ProcessedText {
  text: string;
  markers: PauseMarker[];
  estimatedDurationSec: number;
}

const MARKER_PATTERN = /\[(BEAT|PAUSE)\]/gi;
const VISUAL_COMMENT_PATTERN = /<!--\s*VISUAL:.*?-->/gs;
const WORDS_PER_MINUTE = 150;

/** Duration in seconds added per marker type. */
const MARKER_DURATIONS: Record<string, number> = {
  beat: 0.5,
  pause: 1.0,
};

/**
 * Strip [BEAT] and [PAUSE] markers from narration text,
 * recording their character positions in the cleaned text.
 */
export function processNarrationText(raw: string): ProcessedText {
  // First strip HTML visual comments
  let text = raw.replace(VISUAL_COMMENT_PATTERN, "").trim();

  const markers: PauseMarker[] = [];
  let offset = 0;

  text = text.replace(MARKER_PATTERN, (match, type, index) => {
    markers.push({
      type: type.toLowerCase() as "beat" | "pause",
      position: index - offset,
    });
    offset += match.length;
    return "";
  });

  // Clean up extra whitespace left by removals
  text = text.replace(/\s{2,}/g, " ").trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const speakingDuration = (wordCount / WORDS_PER_MINUTE) * 60;
  const markerDuration = markers.reduce(
    (sum, m) => sum + (MARKER_DURATIONS[m.type] ?? 0),
    0,
  );

  return { text, markers, estimatedDurationSec: speakingDuration + markerDuration };
}

/**
 * Estimate speaking duration for a piece of text.
 *
 * Strips [BEAT]/[PAUSE] markers before counting words, then adds
 * pause time for each marker.
 */
export function estimateDuration(text: string): number {
  const processed = processNarrationText(text);
  return processed.estimatedDurationSec;
}
