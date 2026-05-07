import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	open as openDialog,
	save as saveDialog,
	confirm as confirmDialog,
} from "@tauri-apps/plugin-dialog";
import {
	Download,
	Upload,
	Trash2,
	RefreshCw,
	AlertTriangle,
	CheckCircle2,
} from "lucide-react";

import {
	backupExport,
	backupImport,
	backupList,
	backupDelete,
	type BackupSummary,
	type ImportPreview,
	type ImportResult,
} from "@/lib/tauri-cmd";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/settings/backup")({
	component: BackupSettings,
});

const BACKUPS_QUERY_KEY = ["settings", "backup", "list"] as const;

function BackupSettings() {
	const qc = useQueryClient();
	const backups = useQuery({
		queryKey: BACKUPS_QUERY_KEY,
		queryFn: () => backupList(),
	});

	const [busy, setBusy] = useState<null | "export" | "import">(null);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [preview, setPreview] = useState<{
		src: string;
		preview: ImportPreview;
	} | null>(null);
	const [restartPrompt, setRestartPrompt] = useState<ImportResult | null>(null);

	const refreshList = () =>
		qc.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY });

	async function onExport() {
		setError(null);
		setSuccess(null);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const dest = await saveDialog({
			defaultPath: `ikenga-backup-${stamp}.ikbak`,
			filters: [{ name: "Ikenga backup", extensions: ["ikbak"] }],
		});
		if (!dest) return;
		setBusy("export");
		try {
			const res = await backupExport(dest);
			setSuccess(
				`Exported ${formatBytes(res.size_bytes)} → ${shortPath(res.path)}`,
			);
			refreshList();
		} catch (e) {
			setError(`Export failed: ${String(e)}`);
		} finally {
			setBusy(null);
		}
	}

	async function onPickAndPreview() {
		setError(null);
		setSuccess(null);
		const src = await openDialog({
			multiple: false,
			filters: [{ name: "Ikenga backup", extensions: ["ikbak"] }],
		});
		if (!src || typeof src !== "string") return;
		setBusy("import");
		try {
			const res = (await backupImport(src, { dryRun: true })) as ImportPreview;
			setPreview({ src, preview: res });
		} catch (e) {
			setError(`Could not read backup: ${String(e)}`);
		} finally {
			setBusy(null);
		}
	}

	async function onConfirmImport() {
		if (!preview) return;
		const ok = await confirmDialog(
			"This will replace your local app data on next launch. Continue?",
			{ title: "Restore backup", kind: "warning" },
		);
		if (!ok) return;
		setBusy("import");
		try {
			const res = (await backupImport(preview.src, {
				dryRun: false,
			})) as ImportResult;
			setPreview(null);
			setRestartPrompt(res);
		} catch (e) {
			setError(`Restore failed: ${String(e)}`);
		} finally {
			setBusy(null);
		}
	}

	async function onDelete(path: string) {
		const ok = await confirmDialog(`Delete this backup?\n${shortPath(path)}`, {
			title: "Delete backup",
			kind: "warning",
		});
		if (!ok) return;
		try {
			await backupDelete(path);
			refreshList();
		} catch (e) {
			setError(`Delete failed: ${String(e)}`);
		}
	}

	return (
		<div className="mx-auto max-w-3xl space-y-6 p-6">
			<header>
				<h1 className="text-2xl font-semibold">Backup &amp; Restore</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Export your local app data (SQLite) to a single <code>.ikbak</code>{" "}
					file. Restore stages the new database and applies it on the next
					launch.
				</p>
			</header>

			{error && (
				<Alert variant="destructive">
					<AlertTriangle className="h-4 w-4" />
					<AlertTitle>Error</AlertTitle>
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{success && (
				<Alert>
					<CheckCircle2 className="h-4 w-4" />
					<AlertTitle>Done</AlertTitle>
					<AlertDescription>{success}</AlertDescription>
				</Alert>
			)}

			<Card className="p-5">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 className="text-base font-medium">Export now</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Phase 1 — SQLite only. Secrets and installed pkgs are not yet
							included.
						</p>
					</div>
					<Button onClick={onExport} disabled={busy !== null}>
						<Download className="mr-2 h-4 w-4" />
						{busy === "export" ? "Exporting…" : "Export"}
					</Button>
				</div>
			</Card>

			<Card className="p-5">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h2 className="text-base font-medium">Restore from file</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Pick a <code>.ikbak</code> file. You'll see a preview before
							anything is applied.
						</p>
					</div>
					<Button
						variant="outline"
						onClick={onPickAndPreview}
						disabled={busy !== null}
					>
						<Upload className="mr-2 h-4 w-4" />
						{busy === "import" ? "Reading…" : "Restore"}
					</Button>
				</div>
			</Card>

			<Card className="p-5">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-base font-medium">Local backups</h2>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => refreshList()}
						disabled={backups.isFetching}
					>
						<RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
					</Button>
				</div>
				{backups.isLoading ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : backups.data && backups.data.length > 0 ? (
					<ul className="divide-y divide-border">
						{backups.data.map((b) => (
							<BackupRow key={b.path} b={b} onDelete={() => onDelete(b.path)} />
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">
						No local backups yet. Auto-backup arrives in phase 4.
					</p>
				)}
			</Card>

			<Dialog
				open={!!preview}
				onOpenChange={(open) => {
					if (!open) setPreview(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Restore preview</DialogTitle>
						<DialogDescription>
							Review the bundle before applying.
						</DialogDescription>
					</DialogHeader>
					{preview && (
						<div className="space-y-3 text-sm">
							<KV k="Source" v={shortPath(preview.src)} />
							<KV k="Created" v={preview.preview.manifest.created_at} />
							<KV k="From host" v={preview.preview.manifest.hostname} />
							<KV
								k="Size"
								v={formatBytes(preview.preview.size_bytes)}
							/>
							<KV
								k="Schema"
								v={describeSchemaAction(preview.preview.schema_action)}
							/>
							<KV
								k="Secrets"
								v={preview.preview.manifest.has_secrets ? "Yes" : "No"}
							/>
							{preview.preview.schema_action.kind === "newer_than_app" && (
								<Alert variant="destructive">
									<AlertDescription>
										Backup is newer than this app version. Upgrade Ikenga before
										restoring.
									</AlertDescription>
								</Alert>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setPreview(null)}>
							Cancel
						</Button>
						<Button
							onClick={onConfirmImport}
							disabled={
								busy !== null ||
								preview?.preview.schema_action.kind === "newer_than_app"
							}
						>
							Apply on next launch
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={!!restartPrompt}
				onOpenChange={(open) => {
					if (!open) setRestartPrompt(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Restart required</DialogTitle>
						<DialogDescription>
							The restore is staged. Quit and reopen Ikenga to apply it. The
							running session is unchanged until then.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setRestartPrompt(null)}>OK</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function BackupRow({
	b,
	onDelete,
}: {
	b: BackupSummary;
	onDelete: () => void;
}) {
	return (
		<li className="flex items-center justify-between gap-4 py-3">
			<div className="min-w-0">
				<div className="truncate text-sm font-medium">{shortPath(b.path)}</div>
				<div className="text-xs text-muted-foreground">
					{b.created_at || "(unparseable manifest)"} · {formatBytes(b.size_bytes)} ·
					schema v{b.schema_version}
				</div>
			</div>
			<Button variant="ghost" size="sm" onClick={onDelete}>
				<Trash2 className="h-4 w-4" />
			</Button>
		</li>
	);
}

function KV({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<span className="text-muted-foreground">{k}</span>
			<span className="truncate font-mono text-xs">{v}</span>
		</div>
	);
}

function describeSchemaAction(a: ImportPreview["schema_action"]): string {
	switch (a.kind) {
		case "match":
			return "Match";
		case "forward":
			return `Migrate forward (v${a.from} → v${a.to})`;
		case "newer_than_app":
			return `Newer than app (v${a.backup} > v${a.app})`;
	}
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortPath(p: string): string {
	const home = "/home/";
	const idx = p.indexOf(home);
	if (idx < 0) return p;
	const slash = p.indexOf("/", idx + home.length);
	return slash > 0 ? `~${p.slice(slash)}` : p;
}
