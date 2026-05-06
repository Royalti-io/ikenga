/**
 * Read-side accessor for the composition registry.
 *
 * Importing this module imports each registered composition for its
 * side-effect (defineComposition() mutates a module-level Map). Call
 * getRegistry() to read the populated map.
 *
 * Mirrors the imports in src/video/Root.tsx — keep the two in lock-step.
 */

import "./compositions/_smoke/SmokeTest";
import "./compositions/AskRoyClipVideo";
import "./compositions/AskRoyV2ClipVideo";

export {
  getRegistry,
  type CompositionDefinition,
} from "./lib/define-composition";
