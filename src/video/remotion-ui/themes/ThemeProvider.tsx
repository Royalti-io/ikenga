import React, { createContext, useContext, useMemo } from "react";
import { royaltiTheme, type ThemeTokens } from "./tokens";

const ThemeContext = createContext<ThemeTokens>(royaltiTheme);

export interface ThemeProviderProps {
  theme?: Partial<ThemeTokens>;
  children: React.ReactNode;
}

function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val && typeof val === "object" && !Array.isArray(val) && typeof base[key] === "object") {
      result[key] = deepMerge(base[key], val);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ theme, children }) => {
  const merged = useMemo(
    () => (theme ? deepMerge(royaltiTheme, theme) as ThemeTokens : royaltiTheme),
    [theme],
  );

  return <ThemeContext.Provider value={merged}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeTokens {
  return useContext(ThemeContext);
}
