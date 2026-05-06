/**
 * word-reconstruct — extracted from storyboard-engine.ts so that caption-converter
 * can import these two symbols without depending on the full storyboard-engine module
 * (which is slated for deletion in Phase 4).
 *
 * DO NOT add other imports or logic here — this file is intentionally minimal.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface CharacterTimestamp {
  character: string;
  startSec: number;
  endSec: number;
}

/** A word reconstructed from character timestamps with precise timing. */
export interface TimedWord {
  word: string;
  startSec: number;
  endSec: number;
  /** Index of first character in the original timestamps array. */
  charStartIndex: number;
  /** Index of last character in the original timestamps array. */
  charEndIndex: number;
}

// ── Word Reconstruction ────────────────────────────────────────────────────

/**
 * Reconstruct words from character timestamps.
 * Groups characters between spaces/newlines into words with timing.
 */
export function reconstructWords(
  timestamps: CharacterTimestamp[],
): TimedWord[] {
  const words: TimedWord[] = [];
  let currentWord = "";
  let wordStartSec = 0;
  let wordEndSec = 0;
  let charStartIndex = 0;

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const isWhitespace = ts.character === " " || ts.character === "\n";

    if (isWhitespace) {
      if (currentWord.length > 0) {
        words.push({
          word: currentWord,
          startSec: wordStartSec,
          endSec: wordEndSec,
          charStartIndex,
          charEndIndex: i - 1,
        });
        currentWord = "";
      }
    } else {
      if (currentWord.length === 0) {
        wordStartSec = ts.startSec;
        charStartIndex = i;
      }
      currentWord += ts.character;
      wordEndSec = ts.endSec;
    }
  }

  // Flush last word
  if (currentWord.length > 0) {
    words.push({
      word: currentWord,
      startSec: wordStartSec,
      endSec: wordEndSec,
      charStartIndex,
      charEndIndex: timestamps.length - 1,
    });
  }

  return words;
}
