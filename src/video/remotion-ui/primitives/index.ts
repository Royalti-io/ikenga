/**
 * Primitives barrel — palette-aware, lofi-respecting, tree-shakeable.
 * Import from "@/video/remotion-ui/primitives".
 *
 * Phase 2A: Stat, RevealList, HighlightWords, KenBurns
 * Phase 2B: Annotation, ChatBubble, AvatarBadge, CaptionBar
 */

// Phase 2A
export { Stat, type StatProps } from "./Stat";
export { RevealList, type RevealListProps, type RevealItem } from "./RevealList";
export { HighlightWords, type HighlightWordsProps, splitSegments } from "./HighlightWords";
export { KenBurns, type KenBurnsProps } from "./KenBurns";

// Phase 2B
export { Annotation, type AnnotationProps } from "./Annotation";
export { ChatBubble, type ChatBubbleProps } from "./ChatBubble";
export { AvatarBadge, type AvatarBadgeProps } from "./AvatarBadge";
export { CaptionBar, type CaptionBarProps, type CaptionPhrase } from "./CaptionBar";
