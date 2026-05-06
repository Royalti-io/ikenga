/**
 * Aspect ratio presets with safe areas.
 * Adapted from remotion-ui (MIT).
 */

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface AspectPreset {
  name: string;
  width: number;
  height: number;
  safeArea?: SafeArea;
}

export const PRESETS: Record<string, AspectPreset> = {
  landscape: {
    name: "Landscape 16:9",
    width: 1920,
    height: 1080,
  },
  portrait: {
    name: "Portrait 9:16",
    width: 1080,
    height: 1920,
    safeArea: { top: 120, right: 40, bottom: 180, left: 40 },
  },
  square: {
    name: "Square 1:1",
    width: 1080,
    height: 1080,
  },
  tall: {
    name: "Tall 4:5",
    width: 1080,
    height: 1350,
  },
  slide: {
    name: "Slide 3:4",
    width: 1080,
    height: 1440,
  },
  wide: {
    name: "Wide 21:9",
    width: 2560,
    height: 1080,
  },
} as const;
