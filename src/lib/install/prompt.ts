// Generates the Claude install prompt from a chosen source + manifest preview
// + iyke endpoint. The prompt is the contract between the FE (which gathered
// the user's selections) and Claude (which performs the actual install work).
//
// Two consumers today:
//   1. The in-app spawn flow — feeds this string straight into claudeChatSpawn.
//   2. The clipboard handoff — copied verbatim for the user to paste into a
//      terminal Claude session.
// Both consumers must use the same prompt so an install run by either path
// produces the same result.

import type { PkgManifestPreview } from '@/lib/tauri-cmd';

export type InstallSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref?: string }
  | { kind: 'catalog'; entry: { id: string; name: string; source: InstallSource } };

export interface BuildPromptInput {
  source: InstallSource;
  /** Parsed manifest preview. May be null if the source is a git URL we
   *  haven't cloned yet — Claude resolves it post-clone. */
  manifest: PkgManifestPreview | null;
  /** User's settings overrides keyed by manifest field. */
  settingsOverrides: Record<string, unknown>;
  /** Iyke endpoint Claude can use to drive the running app. */
  iyke: { url: string; token: string };
}

export function buildInstallPrompt(input: BuildPromptInput): string {
  const { source, manifest, settingsOverrides, iyke } = input;

  const idLine = manifest?.id ?? '<resolve from manifest after clone>';
  const nameLine = manifest?.name ?? '<unknown until cloned>';

  const sourceBlock = (() => {
    switch (source.kind) {
      case 'local':
        return `Local path: ${source.path}`;
      case 'git':
        return `Git URL: ${source.url}${source.ref ? ` (ref: ${source.ref})` : ''}`;
      case 'catalog':
        return `Catalog entry: ${source.entry.id} — ${source.entry.name}\n  Resolved source: ${describeSource(source.entry.source)}`;
    }
  })();

  const permsBlock = manifest?.permissions
    ? formatPermissions(manifest.permissions as Record<string, unknown>)
    : '(none declared, or pending manifest read)';

  const settingsBlock = manifest?.settings?.schema?.length
    ? formatSettings(manifest.settings.schema, settingsOverrides)
    : '(no settings schema declared)';

  const cloneStep =
    source.kind === 'git'
      ? `1. Clone the source repo into \`~/.local/share/app.ikenga/staging/${manifest?.id ?? 'pending-id'}\`. Use the ref if provided, otherwise default branch.`
      : `1. The package is already on disk; skip the clone step.`;

  const finalPath =
    source.kind === 'git'
      ? `~/.local/share/app.ikenga/staging/${manifest?.id ?? 'pending-id'}`
      : source.kind === 'local'
        ? source.path
        : describeSource(source.entry.source);

  return [
    `# Ikenga Desktop — Package Install`,
    ``,
    `Install package \`${idLine}\` (${nameLine}) into the running PA desktop app.`,
    ``,
    `## Source`,
    sourceBlock,
    ``,
    `## User selections`,
    settingsBlock,
    ``,
    `## Permissions the package declared`,
    permsBlock,
    ``,
    `## Install steps`,
    cloneStep,
    `2. Verify \`${finalPath}/manifest.json\` parses and matches the user's selections — patch it in place if any setting needs to be baked into the manifest.`,
    `3. Run any \`INSTALL.md\` steps documented at the package root (read it if present; ignore if absent).`,
    `4. Call \`pkg_install_from_path\` via the iyke control bridge to register the package against the kernel:`,
    `   \`\`\``,
    `   curl -s ${iyke.url}/iyke/state -H 'Authorization: Bearer ${iyke.token}' >/dev/null  # sanity`,
    `   # Then ask the user to click "Install" in the app, or run pkg_install_from_path directly via a Tauri call.`,
    `   \`\`\``,
    `   (If running headless, the cleanest path is to use the \`iyke\` skill commands to navigate to \`/install?source=...\` and trigger the in-app installer.)`,
    `5. After install, run \`iyke logs | grep pkg_kernel\` and confirm the kernel logged \`installed \\\`${idLine}\\\` v…\`.`,
    `6. Surface the result to the user. If anything failed, surface the specific registry that errored — the kernel rolls back automatically.`,
    ``,
    `## Iyke endpoint (for driving the app)`,
    `URL:   ${iyke.url}`,
    `Token: ${iyke.token}`,
    ``,
    `Use the \`iyke\` skill (preinstalled via \`com.ikenga.iyke\`) to drive the app — read DOM, capture screenshots, click buttons, navigate. Do not invent new HTTP routes; stick to the documented iyke surface.`,
  ].join('\n');
}

function describeSource(s: InstallSource): string {
  switch (s.kind) {
    case 'local':
      return s.path;
    case 'git':
      return `${s.url}${s.ref ? `#${s.ref}` : ''}`;
    case 'catalog':
      return s.entry.id;
  }
}

function formatPermissions(perms: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(perms)) {
    if (Array.isArray(v) && v.length > 0) {
      lines.push(`  ${k}:`);
      for (const item of v) lines.push(`    - ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    }
  }
  return lines.length ? lines.join('\n') : '(none declared)';
}

interface SchemaField {
  key: string;
  type: string;
  label: string;
  default?: unknown;
}

function formatSettings(schema: SchemaField[], overrides: Record<string, unknown>): string {
  return schema
    .map((f) => {
      const v = f.key in overrides ? overrides[f.key] : f.default;
      return `  ${f.key} (${f.type}, ${f.label}): ${JSON.stringify(v)}`;
    })
    .join('\n');
}
