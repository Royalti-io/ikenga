/**
 * Caption Converter — bridges ElevenLabs character timestamps
 * to @remotion/captions format for word-level subtitle rendering.
 *
 * Flow:
 * 1. ElevenLabs characterTimestamps → reconstructWords() → TimedWord[]
 * 2. TimedWord[] → toCaptions() → Caption[]
 * 3. Caption[] → createTikTokStyleCaptions() → TikTokPage[] (paginated groups)
 */

import type { Caption, TikTokPage } from "@remotion/captions";
import { createTikTokStyleCaptions } from "@remotion/captions";
import { reconstructWords, type CharacterTimestamp } from "./word-reconstruct";

/**
 * Convert ElevenLabs character timestamps to @remotion/captions Caption array.
 */
export function toCaptions(timestamps: CharacterTimestamp[]): Caption[] {
  const words = reconstructWords(timestamps);

  return words.map((w) => ({
    text: w.word,
    startMs: Math.round(w.startSec * 1000),
    endMs: Math.round(w.endSec * 1000),
    timestampMs: Math.round(w.startSec * 1000),
    confidence: 1,
  }));
}

/**
 * Convert character timestamps to paginated TikTok-style caption pages.
 *
 * Each page is a group of words shown together (3-5 words),
 * with timing for word-by-word highlighting.
 *
 * @param timestamps ElevenLabs character timestamps
 * @param combineWithinMs Group words within this time window (default: 1200ms)
 */
export function toCaptionPages(
  timestamps: CharacterTimestamp[],
  combineWithinMs: number = 1200,
): TikTokPage[] {
  const captions = toCaptions(timestamps);

  if (captions.length === 0) return [];

  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: combineWithinMs,
  });

  return pages;
}
