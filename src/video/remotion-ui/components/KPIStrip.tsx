import React from "react";
import { Stagger } from "../core/Stagger";
import { StatBlock, type StatBlockProps } from "./StatBlock";

export interface KPIStripProps {
  items: StatBlockProps[];
  gap?: number;
  startAt?: number;
  staggerDelay?: number;
}

export const KPIStrip: React.FC<KPIStripProps> = ({
  items,
  gap = 24,
  startAt = 0,
  staggerDelay = 8,
}) => {
  return (
    <Stagger
      startAt={startAt}
      staggerDelay={staggerDelay}
      style={{
        display: "flex",
        flexDirection: "row",
        gap,
        justifyContent: "center",
        alignItems: "stretch",
      }}
    >
      {items.map((item, i) => (
        <StatBlock key={i} {...item} />
      ))}
    </Stagger>
  );
};
