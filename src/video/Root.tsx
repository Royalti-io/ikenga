/**
 * Root — Remotion composition registry.
 *
 * Phase 3+: ALL compositions self-register via defineComposition(). To add a
 * new composition, import its module here — the side-effect call to
 * defineComposition() registers it. renderCompositions() then emits the
 * <Composition> JSX automatically.
 *
 * Legacy schema-driven compositions (BlogExplainerVideo, MarketingVideo, the
 * Marketing/Ads/Stills folders, etc.) are no longer imported here. Phase 4
 * will delete those files outright; until then they live as orphaned modules
 * in src/compositions/ but are not registered with Remotion.
 */

import React from "react";
import { renderCompositions } from "./lib/define-composition";

// ── Self-registering compositions (import = register) ─────────────────────
import "./compositions/_smoke/SmokeTest";
import "./compositions/AskRoyClipVideo";
import "./compositions/AskRoyV2ClipVideo";

// ── Root ──────────────────────────────────────────────────────────────────

export const RemotionRoot: React.FC = () => {
  return <>{renderCompositions()}</>;
};
