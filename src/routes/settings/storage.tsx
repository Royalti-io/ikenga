import { Link, createFileRoute } from '@tanstack/react-router';
import { Archive } from 'lucide-react';

import { Button } from '@/components/ui/button';

import {
  ClearDataSectionBody,
  FileRootsSectionBody,
  ScreenshotDirSectionBody,
} from './-components/legacy-sections';
import { SettingGroup } from './-components/setting-group';
import { SettingRow } from './-components/setting-row';

function StoragePage() {
  return (
    <div className="flex h-full flex-col">
      {/* Toolbar / breadcrumb */}
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border-soft px-6 text-xs text-muted-foreground">
        <span>
          Settings · <span className="font-semibold text-foreground">Storage</span>
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <header className="space-y-1">
            <h2
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Storage
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              Where Ikenga reads from and writes to on disk — file-browser roots, screenshot
              destination, and the local SQLite + browser caches that power chat, viewer, and
              layout state.
            </p>
          </header>

          {/* ─── File roots ─────────────────────────────────────────── */}
          <SettingGroup title="File roots">
            <FileRootsSectionBody />
          </SettingGroup>

          {/* ─── Screenshots ────────────────────────────────────────── */}
          <SettingGroup title="Screenshots">
            <ScreenshotDirSectionBody />
          </SettingGroup>

          {/* ─── Local data ─────────────────────────────────────────── */}
          <SettingGroup title="Local data">
            <ClearDataSectionBody />
            <SettingRow
              label="Backup & restore"
              desc="Export local app data (SQLite, optionally vault secrets and installed-pkg list) to a single .ikbak file, or restore a previous bundle."
            >
              <Button asChild variant="outline" size="sm">
                <Link to="/settings/backup">
                  <Archive className="mr-1 h-3.5 w-3.5" />
                  Open backup
                </Link>
              </Button>
            </SettingRow>
          </SettingGroup>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings/storage')({
  component: StoragePage,
});
