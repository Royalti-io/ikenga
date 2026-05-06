import { Palette, ImageIcon, type LucideIcon } from 'lucide-react';
import type { MiniAppMode, ActivityMode } from '@/lib/shell/shell-store';

export interface MiniApp {
  id: MiniAppMode;
  name: string;
  description: string;
  Icon: LucideIcon;
  phaseTag: string;
}

// Treat this array as the install registry: each entry promotes a mini-app
// to its own activity-bar icon. Adding/removing entries here is the only
// thing that changes the rail. Studio is now a CoreMode, not a mini-app.
export const MINI_APPS: MiniApp[] = [
  {
    id: 'canvas-design',
    name: 'Canvas Design',
    description: 'Branded graphics for blog and social.',
    Icon: Palette,
    phaseTag: 'Phase 6',
  },
  {
    id: 'image-generator',
    name: 'Image Generator',
    description: 'Gemini / GPT image prompts.',
    Icon: ImageIcon,
    phaseTag: 'Phase 6',
  },
];

export const MINI_APP_BY_ID: Partial<Record<ActivityMode, MiniApp>> = MINI_APPS.reduce(
  (acc, app) => {
    acc[app.id] = app;
    return acc;
  },
  {} as Partial<Record<ActivityMode, MiniApp>>,
);
