import { Sparkles } from 'lucide-react';
import { MINI_APP_BY_ID } from '@/shell/mini-apps-config';
import type { MiniAppName } from '@/lib/panes/types';
import { VideoStudioPane } from './video-studio-pane';
import { HyperframesPane } from './hyperframes-pane';
import { StoryboardPane } from './storyboard-pane';

interface MiniAppViewProps {
  name: MiniAppName;
  paneId: string;
}

export function MiniAppView({ name, paneId }: MiniAppViewProps) {
  if (name === 'video-engine') return <VideoStudioPane paneId={paneId} />;
  if (name === 'hyperframes') return <HyperframesPane paneId={paneId} />;
  if (name === 'storyboard') return <StoryboardPane paneId={paneId} />;

  // Stub for mini-apps that haven't shipped a real surface yet (storyboard,
  // canvas-design, image-generator). Same look as the rail-mode placeholder
  // so the experience is consistent.
  const app = MINI_APP_BY_ID[name];
  const Icon = app?.Icon ?? Sparkles;
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
      <div className="max-w-sm text-center">
        <Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">{app?.name ?? name}</div>
        <div className="mt-2 text-xs text-muted-foreground italic">
          {app?.phaseTag ?? 'Coming soon'}
        </div>
      </div>
    </div>
  );
}
