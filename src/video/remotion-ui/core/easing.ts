/**
 * String-based easing utility wrapping Remotion's interpolate.
 * Adapted from remotion-ui (MIT). Provides 22 named easing types.
 */

import { interpolate, Easing } from "remotion";

export type EasingType =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "ease-in-quad"
  | "ease-out-quad"
  | "ease-in-out-quad"
  | "ease-in-cubic"
  | "ease-out-cubic"
  | "ease-in-out-cubic"
  | "ease-in-quart"
  | "ease-out-quart"
  | "ease-in-out-quart"
  | "ease-in-expo"
  | "ease-out-expo"
  | "ease-in-out-expo"
  | "ease-in-back"
  | "ease-out-back"
  | "ease-in-out-back"
  | "ease-in-circ"
  | "ease-out-circ"
  | "ease-in-out-circ";

const easingMap: Record<EasingType, (t: number) => number> = {
  linear: (t) => t,
  "ease-in": Easing.in(Easing.ease),
  "ease-out": Easing.out(Easing.ease),
  "ease-in-out": Easing.inOut(Easing.ease),
  "ease-in-quad": Easing.in(Easing.quad),
  "ease-out-quad": Easing.out(Easing.quad),
  "ease-in-out-quad": Easing.inOut(Easing.quad),
  "ease-in-cubic": Easing.in(Easing.cubic),
  "ease-out-cubic": Easing.out(Easing.cubic),
  "ease-in-out-cubic": Easing.inOut(Easing.cubic),
  // Fixed: remotion-ui maps these to cubic incorrectly
  "ease-in-quart": (t) => t * t * t * t,
  "ease-out-quart": (t) => 1 - Math.pow(1 - t, 4),
  "ease-in-out-quart": (t) =>
    t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
  "ease-in-expo": Easing.in(Easing.exp),
  "ease-out-expo": Easing.out(Easing.exp),
  "ease-in-out-expo": Easing.inOut(Easing.exp),
  "ease-in-back": Easing.in(Easing.back(1.7)),
  "ease-out-back": Easing.out(Easing.back(1.7)),
  "ease-in-out-back": Easing.inOut(Easing.back(1.7)),
  "ease-in-circ": Easing.in(Easing.circle),
  "ease-out-circ": Easing.out(Easing.circle),
  "ease-in-out-circ": Easing.inOut(Easing.circle),
};

/**
 * Interpolate with a named easing type.
 * Wraps Remotion's `interpolate` with clamping on both ends.
 */
export function interpolateWithEasing(
  frame: number,
  inputRange: [number, number],
  outputRange: [number, number],
  easing: EasingType = "linear",
): number {
  return interpolate(frame, inputRange, outputRange, {
    easing: easingMap[easing],
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
