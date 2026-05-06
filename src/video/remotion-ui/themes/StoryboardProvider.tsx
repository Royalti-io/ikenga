/**
 * StoryboardProvider — exposes beat metadata + narration manifest to the
 * entire composition tree via React context.
 *
 * This is OPTIONAL. Primitives work without it; they simply lose access to
 * narration-sync features. Wrapping the composition root with this provider
 * lets any primitive call `useStoryboard()` to ask:
 *   "What beat are we in right now, and what is its narration excerpt?"
 *
 * The `currentBeatId` is typically computed once in the composition root by
 * iterating beats against `useCurrentFrame()` and passed down here. Phase 3
 * (the freeform pipeline) will show the pattern for this.
 *
 * NarrationManifest shape mirrors the storyboard.json narration field:
 *   { audio: string; words: { word: string; start: number; end: number }[] }
 *
 * This is deliberately a subset of the full narration.json — only the data
 * a primitive needs to sync to narration timing.
 */

import React, { createContext, useContext } from "react";
import type { Beat } from "../../lib/define-beats";

// ── Types ──────────────────────────────────────────────────────────────────

export type NarrationWord = {
  word: string;
  /** Start time in seconds (composition-absolute). */
  start: number;
  /** End time in seconds. */
  end: number;
};

export type NarrationManifest = {
  /** Path to the audio file (relative to public/ or staticFile). */
  audio: string;
  /** Word-level timestamps. */
  words: NarrationWord[];
};

export type StoryboardContextValue = {
  /** Composition slug (e.g. "ask-roy-clip"). */
  slug: string;
  /** Full beats array as returned by defineBeats(). */
  beats: Beat[];
  /** Optional narration manifest. Only present when audio is synced. */
  narration?: NarrationManifest;
  /** ID of the beat active at the current frame (set by composition root). */
  currentBeatId?: string;
};

// ── Context + defaults ─────────────────────────────────────────────────────

const defaultValue: StoryboardContextValue = {
  slug: "",
  beats: [],
};

const StoryboardContext = createContext<StoryboardContextValue>(defaultValue);

// ── Provider ───────────────────────────────────────────────────────────────

export interface StoryboardProviderProps extends StoryboardContextValue {
  children: React.ReactNode;
}

export const StoryboardProvider: React.FC<StoryboardProviderProps> = ({
  children,
  ...value
}) => {
  return (
    <StoryboardContext.Provider value={value}>
      {children}
    </StoryboardContext.Provider>
  );
};

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * Returns the StoryboardContextValue from the nearest StoryboardProvider.
 * When no provider is present, returns `{ slug: "", beats: [] }`.
 *
 * Safe to call in any primitive — check `ctx.beats.length > 0` before using.
 */
export function useStoryboard(): StoryboardContextValue {
  return useContext(StoryboardContext);
}
