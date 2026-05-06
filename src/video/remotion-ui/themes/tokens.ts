/**
 * Design tokens for the Royalti Video Engine theme system.
 * Values sourced from Pencil design system (royalti-client.pen).
 * Adapted from remotion-ui token structure (MIT).
 */

export interface ThemeTokens {
  colors: {
    background: string;
    foreground: string;
    card: string;
    cardForeground: string;
    primary: string;
    primaryForeground: string;
    secondary: string;
    secondaryForeground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    destructive: string;
    destructiveForeground: string;
    success: string;
    successForeground: string;
    warning: string;
    warningForeground: string;
    info: string;
    infoForeground: string;
    border: string;
    gradientFrom: string;
    gradientTo: string;
  };
  typography: {
    fontFamily: string;
    monoFontFamily: string;
    fontSize: {
      xs: number;
      sm: number;
      base: number;
      lg: number;
      xl: number;
      "2xl": number;
      "3xl": number;
      "4xl": number;
      "5xl": number;
    };
    fontWeight: {
      normal: number;
      medium: number;
      semibold: number;
      bold: number;
      extrabold: number;
    };
    lineHeight: {
      tight: number;
      normal: number;
      relaxed: number;
    };
  };
  spacing: {
    0: number;
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
    6: number;
    8: number;
    10: number;
    12: number;
    16: number;
  };
  radius: {
    none: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    full: number;
  };
}

/**
 * Royalti dark theme — used for all video compositions.
 * Videos always render on dark backgrounds.
 */
export const royaltiTheme: ThemeTokens = {
  colors: {
    background: "#0D0D0D",
    foreground: "#F8FAFC",
    card: "#1A1A1A",
    cardForeground: "#F8FAFC",
    primary: "#006666",
    primaryForeground: "#FFFFFF",
    secondary: "#1F2937",
    secondaryForeground: "#F8FAFC",
    muted: "#1F1F1F",
    mutedForeground: "#8899AA",
    accent: "#006666",
    accentForeground: "#FFFFFF",
    destructive: "#EF4444",
    destructiveForeground: "#FFFFFF",
    success: "#10B981",
    successForeground: "#FFFFFF",
    warning: "#F59E0B",
    warningForeground: "#000000",
    info: "#3B82F6",
    infoForeground: "#FFFFFF",
    border: "#1F1F1F",
    gradientFrom: "#2A7B7B",
    gradientTo: "#006666",
  },
  typography: {
    fontFamily: "Plus Jakarta Sans",
    monoFontFamily: "JetBrains Mono",
    fontSize: {
      xs: 16,
      sm: 20,
      base: 24,
      lg: 28,
      xl: 32,
      "2xl": 40,
      "3xl": 48,
      "4xl": 56,
      "5xl": 64,
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      extrabold: 800,
    },
    lineHeight: {
      tight: 1.1,
      normal: 1.4,
      relaxed: 1.6,
    },
  },
  spacing: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 20,
    6: 24,
    8: 32,
    10: 40,
    12: 48,
    16: 64,
  },
  radius: {
    none: 0,
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999,
  },
};
