/**
 * useNarrationSync — frame-accurate narration lookup for freeform compositions.
 *
 * Takes a NarrationManifest (the same shape stored in storyboard.json's
 * `narration.words` array) and returns helpers for mapping text or timestamps
 * to composition frames.
 *
 * This is a companion to caption-converter.ts. caption-converter converts
 * ElevenLabs characterTimestamps → Caption[] → TikTokPage[] for subtitle
 * rendering. useNarrationSync handles the query side: "at what frame does
 * word X appear?"
 *
 * NarrationManifest shape:
 *   { words: { word: string; start: number; end: number }[], fps?: number }
 *
 * `start` / `end` are in seconds (composition-absolute, matching ElevenLabs
 * alignment_info / characterTimestamps rebuilt via reconstructWords).
 *
 * Note: this is a plain function, not a React hook — the name prefix
 * `useNarrationSync` matches the hook convention but the function itself
 * has no React dependency and can be called at module scope for tests.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type NarrationWord = {
  word: string;
  /** Seconds from composition start. */
  start: number;
  end: number;
};

export type NarrationManifestInput = {
  words: NarrationWord[];
  /** fps override. Defaults to 30. */
  fps?: number;
};

export type NarrationSync = {
  /**
   * Returns the start frame of the nth occurrence of `text` in the narration.
   *
   * Word matching is case-insensitive and strips leading/trailing punctuation
   * for robustness (so "Roy," matches "Roy").
   *
   * @param text  The word to search for (single word only).
   * @param occurrence  1-based occurrence index. Default 1 = first occurrence.
   * @returns Start frame, or null if not found.
   */
  frameForWord(text: string, occurrence?: number): number | null;

  /**
   * Convert a composition-absolute time in seconds to a frame number.
   * Equivalent to Math.floor(seconds * fps).
   */
  frameForSecond(s: number): number;

  /** fps used for all frame calculations. */
  fps: number;
};

// ── Normalisation helper ───────────────────────────────────────────────────

/** Strip leading/trailing punctuation and lowercase for fuzzy matching. */
function normalise(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "");
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Build a NarrationSync helper from a narration manifest.
 *
 * @example
 * const sync = useNarrationSync({ words: narration.words, fps: 30 });
 * const frame = sync.frameForWord("Roy");           // first "Roy"
 * const frame2 = sync.frameForWord("the", 2);       // second "the"
 * const frame3 = sync.frameForSecond(15.256);        // explicit timestamp
 */
export function useNarrationSync(manifest: NarrationManifestInput): NarrationSync {
  const fps = manifest.fps ?? 30;
  const words = manifest.words;

  function frameForWord(text: string, occurrence = 1): number | null {
    const target = normalise(text);
    let count = 0;

    for (const w of words) {
      if (normalise(w.word) === target) {
        count++;
        if (count === occurrence) {
          return Math.floor(w.start * fps);
        }
      }
    }

    return null;
  }

  function frameForSecond(s: number): number {
    return Math.floor(s * fps);
  }

  return { frameForWord, frameForSecond, fps };
}
