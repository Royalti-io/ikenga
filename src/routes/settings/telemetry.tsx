// Settings → Telemetry — direct edit for `telemetryConsent`. Mirrors the
// onboarding telemetry step but skips the side-by-side "what we send" panel
// (the user has already seen that during onboarding; here we just need a
// toggle). Default is OFF per APPROVAL.md, and write-through to
// settings_kv happens automatically via the store setter.

import { createFileRoute } from '@tanstack/react-router';

import { Switch } from '@/components/ui/switch';
import { useShellStore } from '@/lib/shell/shell-store';

import { SettingGroup } from './-components/setting-group';
import { SettingRow } from './-components/setting-row';

function TelemetrySettingsPage() {
	const telemetryConsent = useShellStore((s) => s.telemetryConsent);
	const setTelemetryConsent = useShellStore((s) => s.setTelemetryConsent);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 items-center gap-3 border-b border-border-soft px-6 text-xs text-muted-foreground">
				<span>
					Settings · <span className="font-semibold text-foreground">Telemetry</span>
				</span>
			</div>

			<div className="flex-1 overflow-y-auto px-6 py-6">
				<div className="mx-auto max-w-3xl space-y-6">
					<header className="space-y-1">
						<h2
							className="text-2xl font-semibold tracking-tight"
							style={{ fontFamily: 'var(--font-display)' }}
						>
							Telemetry
						</h2>
						<p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
							Anonymous detection + crash stats. Default off — we never opt anyone in. You can flip
							this any time without restarting; sidecars pick up the new value on their next run.
						</p>
					</header>

					<SettingGroup title="Consent">
						<SettingRow
							label="Share anonymous detection & crash stats"
							desc="Sent to telemetry.ikenga.ai · scrubbed at edge · 30-day retention. Crashes are logged locally to ~/.ikenga/crash/ either way for your own debugging."
						>
							<Switch
								checked={telemetryConsent}
								onCheckedChange={setTelemetryConsent}
								data-testid="settings-telemetry-toggle"
							/>
						</SettingRow>
					</SettingGroup>

					<SettingGroup title="What we send">
						<ul className="grid gap-1 px-4 py-3 text-[12px] text-muted-foreground">
							<li>Installed pkg names + versions</li>
							<li>OS + arch + Tauri version</li>
							<li>Shell crash stack traces (no user data)</li>
							<li>Anonymous install ID (regenerable)</li>
							<li>Active engine adapter (e.g. claude-code)</li>
							<li>Aggregated feature reach</li>
						</ul>
					</SettingGroup>

					<SettingGroup title="What we never send">
						<ul className="grid gap-1 px-4 py-3 text-[12px] text-muted-foreground">
							<li>File contents or names</li>
							<li>Agent prompts or responses</li>
							<li>Project paths or repo names</li>
							<li>Email, name, or account info</li>
							<li>Stronghold vault contents</li>
							<li>Anything from connected services</li>
						</ul>
					</SettingGroup>
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/settings/telemetry')({
	component: TelemetrySettingsPage,
});
