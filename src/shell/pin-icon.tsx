// PinIcon: resolves a `{ iconLucide, iconEmoji }` pair into an icon node.
// Lucide name takes precedence (typed, sized to match the rail). Emoji is
// the fallback. If neither is set, falls back to a generic Folder/Pin
// glyph the caller picks via `fallback`.
//
// Lucide icon names use kebab-case from day one (matches the dynamic-icons
// loader's `iconNames` array). Unknown names render as the fallback.

import { Suspense } from 'react';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import type { LucideIcon } from 'lucide-react';

interface PinIconProps {
  iconLucide: string | null;
  iconEmoji: string | null;
  Fallback: LucideIcon;
  className?: string;
  /** Tailwind size class. Default `h-[18px] w-[18px]` (matches RailButton). */
  sizeClass?: string;
}

export function PinIcon({
  iconLucide,
  iconEmoji,
  Fallback,
  className,
  sizeClass = 'h-[18px] w-[18px]',
}: PinIconProps) {
  if (iconLucide) {
    return (
      <Suspense
        fallback={<Fallback className={`${sizeClass} ${className ?? ''}`} />}
      >
        <DynamicIcon
          name={iconLucide as IconName}
          className={`${sizeClass} ${className ?? ''}`}
        />
      </Suspense>
    );
  }
  if (iconEmoji) {
    // Emoji size is roughly visual-equivalent at the same box; nudge with
    // leading-none so it centers in the same grid as a lucide glyph.
    return (
      <span
        aria-hidden="true"
        className={`${sizeClass} ${className ?? ''} grid place-items-center text-[15px] leading-none`}
      >
        {iconEmoji}
      </span>
    );
  }
  return <Fallback className={`${sizeClass} ${className ?? ''}`} />;
}
