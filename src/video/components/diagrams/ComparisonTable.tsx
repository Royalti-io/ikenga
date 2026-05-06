/**
 * ComparisonTable — animated table that builds row by row.
 * Used for distributor and PRO comparisons.
 *
 * V6: Uses useStaggeredReveal + useProgressBar hooks.
 */

import React from "react";
import { useVideoConfig } from "remotion";
import { useStaggeredReveal, useProgressBar } from "../../hooks";
import { fontFamily } from "../../config/fonts";
import { VIDEO_COLORS, BRAND, SPRING_CONFIGS } from "../../config/defaults";

export interface TableRow {
  cells: string[];
  accent?: string;
}

export interface ComparisonTableProps {
  headers: string[];
  rows: TableRow[];
  title?: string;
  delay?: number;
  /** Show only first N rows (progressive reveal via storyboard). undefined = show all. */
  visibleCount?: number;
}

const ROW_STAGGER = 10;
const COL_WIDTH_MIN = 200;

export const ComparisonTable = React.memo<ComparisonTableProps>(({
  headers,
  rows,
  title,
  delay = 5,
  visibleCount,
}) => {
  const { width, height } = useVideoConfig();

  const visibleRows = visibleCount !== undefined ? rows.slice(0, visibleCount) : rows;
  const colCount = headers.length;
  const colWidth = Math.max(COL_WIDTH_MIN, Math.floor((width - 200) / colCount));
  const tableWidth = colWidth * colCount;
  const startX = (width - tableWidth) / 2;
  const startY = title ? 220 : 180;

  const headerBar = useProgressBar({
    delay,
    springConfig: { damping: 20, stiffness: 100 },
  });

  const rowReveal = useStaggeredReveal({
    count: visibleRows.length,
    stagger: ROW_STAGGER,
    delay: delay + 8,
    springConfig: SPRING_CONFIGS.GENTLE,
  });

  return (
    <div style={{ width, height, position: "relative" }}>
      {title && (
        <div style={{
          position: "absolute",
          top: 140,
          width: "100%",
          textAlign: "center",
          fontFamily,
          fontSize: 28,
          fontWeight: 500,
          color: VIDEO_COLORS.mutedText,
          letterSpacing: 2,
          textTransform: "uppercase",
          opacity: headerBar.opacity,
        }}>
          {title}
        </div>
      )}

      <div style={{
        position: "absolute",
        top: startY,
        left: startX,
        display: "flex",
        opacity: headerBar.opacity,
        borderBottom: `2px solid ${BRAND.primary}`,
        paddingBottom: 12,
      }}>
        {headers.map((h, i) => (
          <div key={i} style={{
            width: colWidth,
            fontFamily,
            fontSize: 24,
            fontWeight: 700,
            color: BRAND.primary,
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}>
            {h}
          </div>
        ))}
      </div>

      {visibleRows.map((row, ri) => (
        <div key={ri} style={{
          position: "absolute",
          top: startY + 40 + (ri + 1) * 72,
          left: startX,
          display: "flex",
          opacity: rowReveal.getItemOpacity(ri),
          transform: `translateY(${rowReveal.getItemTranslateY(ri)}px)`,
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          paddingBottom: 16,
          paddingTop: 8,
        }}>
          {row.cells.map((cell, ci) => (
            <div key={ci} style={{
              width: colWidth,
              fontFamily,
              fontSize: ci === 0 ? 26 : 22,
              fontWeight: ci === 0 ? 700 : 400,
              color: ci === 0 ? (row.accent || VIDEO_COLORS.text) : VIDEO_COLORS.text,
              textAlign: "center",
            }}>
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});
