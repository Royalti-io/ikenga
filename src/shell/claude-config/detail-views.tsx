import { useState, type ReactNode } from 'react';
import { Edit3, FileText, Folder, Plus, RotateCcw, Terminal as TermIcon } from 'lucide-react';

import type {
  ClaudeAgent,
  ClaudeCommand,
  ClaudeFrontmatter,
  ClaudeHook,
  ClaudeMcp,
  ClaudeSkill,
  ClaudeSupportingFile,
} from '@/lib/tauri-cmd';
import { claudeConfigReadFile } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';

import { Chips, FrontmatterGrid } from './list-detail';

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function shortPath(p: string): string {
  const home = '/home/nedjamez';
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Split frontmatter values into (tools, mcp tools, skills, others) using the
 *  conventions used across .claude/agents/*.md. Tool values come from
 *  `allowed-tools` (string list); MCP tools start with `mcp__`. */
function partitionTools(allowed: readonly string[]): { tools: string[]; mcp: string[] } {
  const tools: string[] = [];
  const mcp: string[] = [];
  for (const t of allowed) {
    if (t.startsWith('mcp__')) mcp.push(t);
    else tools.push(t);
  }
  return { tools, mcp };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function fmEntries(fm: ClaudeFrontmatter, keys: readonly string[]): Array<[string, ReactNode]> {
  const out: Array<[string, ReactNode]> = [];
  for (const k of keys) {
    const v = fm[k];
    if (v == null) continue;
    if (Array.isArray(v)) {
      out.push([k, `${v.length} items`]);
    } else if (typeof v === 'object') {
      out.push([k, '(object)']);
    } else {
      out.push([k, String(v)]);
    }
  }
  return out;
}

// ─── Clickable file path ───────────────────────────────────────────────────

interface FilePathLinkProps {
  path: string;
  onClick?: (path: string) => void;
  className?: string;
  /** Override the displayed text — defaults to a home-relative `~/...`. */
  display?: string;
}
function FilePathLink({ path, onClick, className, display }: FilePathLinkProps) {
  const text = display ?? shortPath(path);
  if (!onClick) {
    return (
      <span className={className} title={path}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onClick(path)}
      title={`Open ${path}`}
      className={cn(className, 'cursor-pointer')}
      style={{ background: 'transparent', textAlign: 'left' }}
    >
      {text}
    </button>
  );
}

// ─── Action button ─────────────────────────────────────────────────────────

interface IconButtonProps {
  onClick?: () => void;
  children: ReactNode;
  variant?: 'outline' | 'primary';
  title?: string;
}
function IconButton({ onClick, children, variant = 'outline', title }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-[4px] border px-2 py-1 text-[11px] font-medium transition-colors',
        variant === 'outline'
          ? 'border-border bg-transparent text-[var(--fg)] hover:bg-[var(--bg-raised)]'
          : 'border-transparent bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90',
      )}
    >
      {children}
    </button>
  );
}

// ─── Detail header ─────────────────────────────────────────────────────────

interface DetailHeadProps {
  filepath: string;
  title: string;
  scope: 'project' | 'personal';
  description?: string | null;
  actions?: ReactNode;
  onPathClick?: (path: string) => void;
}
function DetailHead({ filepath, title, scope, description, actions, onPathClick }: DetailHeadProps) {
  return (
    <div className="ccfg-detail-head">
      <div className="ccfg-detail-topline">
        <FilePathLink path={filepath} onClick={onPathClick} className="ccfg-filepath" />
        <div className="ccfg-detail-actions">{actions}</div>
      </div>
      <h2>
        {title}
        <span
          className={cn(
            'ccfg-scope-pill',
            scope === 'project' ? 'is-project' : 'is-personal',
          )}
        >
          {scope}
        </span>
      </h2>
      {description && <div className="ccfg-detail-desc">{description}</div>}
    </div>
  );
}

// ─── Agent detail ──────────────────────────────────────────────────────────

interface AgentDetailProps {
  agent: ClaudeAgent;
  onEdit: (path: string) => void;
  onNewSession: (agentName: string, projectRoot: string | null) => void;
}

export function AgentDetailView({ agent, onEdit, onNewSession }: AgentDetailProps) {
  const allowed = asStringArray(agent.frontmatter['allowed-tools']);
  const skillsUsed = asStringArray(agent.frontmatter['skills-used']);
  const { tools, mcp } = partitionTools(allowed);

  const fmRows = fmEntries(agent.frontmatter, [
    'name',
    'model',
    'maxTurns',
  ]);
  fmRows.push(
    [
      'allowed-tools',
      <span style={{ color: 'var(--fg-muted)' }}>
        {allowed.length} ({tools.length} native · {mcp.length} MCP)
      </span>,
    ],
    ['skills-used', `${skillsUsed.length} skills`],
    ['file mtime', formatTime(agent.modifiedMs)],
  );

  return (
    <>
      <DetailHead
        filepath={agent.path}
        onPathClick={onEdit}
        title={agent.name}
        scope={agent.scope}
        description={agent.description}
        actions={
          <>
            <IconButton onClick={() => onEdit(agent.path)} title="Open in editor">
              <Edit3 size={11} /> Edit
            </IconButton>
            <IconButton
              variant="primary"
              onClick={() => onNewSession(agent.name, agent.projectRoot)}
            >
              <Plus size={11} /> New {agent.name} session
            </IconButton>
          </>
        }
      />
      <div className="ccfg-detail-body">
        <Section label="Frontmatter">
          <FrontmatterGrid entries={fmRows} />
        </Section>
        {skillsUsed.length > 0 && (
          <Section
            label="Skills used"
            count={`${skillsUsed.length} of ${skillsUsed.length}`}
          >
            <Chips values={skillsUsed} variant="skill" />
          </Section>
        )}
        {tools.length > 0 && (
          <Section
            label="Allowed tools"
            count={`${Math.min(tools.length, 8)} of ${tools.length}`}
          >
            <Chips values={tools} variant="tool" initial={tools.length > 8 ? 8 : undefined} />
          </Section>
        )}
        {mcp.length > 0 && (
          <Section label="MCP tools" count={`${mcp.length} of ${mcp.length}`}>
            <Chips values={mcp} variant="mcp" />
          </Section>
        )}
        <Section
          label="System prompt · markdown body"
          count={`${agent.body.split('\n').length} lines`}
        >
          <pre className="ccfg-body-preview">{agent.body}</pre>
        </Section>
      </div>
    </>
  );
}

// ─── Skill detail ──────────────────────────────────────────────────────────

interface SkillDetailProps {
  skill: ClaudeSkill;
  onEdit: (path: string) => void;
}
export function SkillDetailView({ skill, onEdit }: SkillDetailProps) {
  const allowed = asStringArray(skill.frontmatter['allowed-tools']);
  const fmRows: Array<[string, ReactNode]> = [
    ['name', skill.name],
    ['when_to_use', skill.frontmatter['when_to_use']
      ? String(skill.frontmatter['when_to_use'])
      : <span style={{ color: 'var(--fg-faint)' }}>—</span>],
    ['allowed-tools', allowed.length ? `${allowed.length} tools` : <span style={{ color: 'var(--fg-faint)' }}>— (inherits caller)</span>],
    ['file mtime', formatTime(skill.modifiedMs)],
  ];
  return (
    <>
      <DetailHead
        filepath={skill.path}
        onPathClick={onEdit}
        title={skill.name}
        scope={skill.scope}
        description={skill.description}
        actions={<IconButton onClick={() => onEdit(skill.path)}><Edit3 size={11} /> Edit</IconButton>}
      />
      <div className="ccfg-detail-body">
        <Section label="Frontmatter">
          <FrontmatterGrid entries={fmRows} />
        </Section>
        {allowed.length > 0 && (
          <Section label="Allowed tools" count={`${allowed.length} of ${allowed.length}`}>
            <Chips values={allowed} variant="tool" />
          </Section>
        )}
        <Section
          label="Supporting files"
          count={`${skill.supportingFiles.length} files · ${formatBytes(
            skill.supportingFiles.reduce((s, f) => s + f.size, 0),
          )}`}
        >
          <SupportingFileTree
            dir={skill.dirPath}
            skillMdPath={skill.path}
            files={skill.supportingFiles}
            onOpen={onEdit}
          />
        </Section>
        <Section label="SKILL.md body" count={`${skill.body.split('\n').length} lines`}>
          <pre className="ccfg-body-preview">{skill.body}</pre>
        </Section>
      </div>
    </>
  );
}

function SupportingFileTree({
  dir,
  skillMdPath,
  files,
  onOpen,
}: {
  dir: string;
  skillMdPath: string;
  files: ClaudeSupportingFile[];
  onOpen: (path: string) => void;
}) {
  const dirName = dir.split('/').filter(Boolean).pop() ?? dir;
  return (
    <div className="ccfg-tree">
      <button type="button" className="ccfg-tree-row dir" onClick={() => onOpen(dir)} title={`Open ${dir}`}>
        <Folder /> {dirName}/
      </button>
      <button
        type="button"
        className="ccfg-tree-row"
        onClick={() => onOpen(skillMdPath)}
        title={`Open ${skillMdPath}`}
      >
        <span className="indent" />
        <FileText /> SKILL.md
      </button>
      {files.map((f) => (
        <button
          type="button"
          className="ccfg-tree-row"
          key={f.path}
          onClick={() => onOpen(f.path)}
          title={`Open ${f.path}`}
        >
          <span className="indent" />
          <FileText /> {f.name}
          <span className="size">{formatBytes(f.size)}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Command detail ────────────────────────────────────────────────────────

interface CommandDetailProps {
  cmd: ClaudeCommand;
  onEdit: (path: string) => void;
  onRun: (cmd: ClaudeCommand) => void;
}
export function CommandDetailView({ cmd, onEdit, onRun }: CommandDetailProps) {
  const allowed = asStringArray(cmd.frontmatter['allowed-tools']);
  const { tools, mcp } = partitionTools(allowed);
  const fmRows: Array<[string, ReactNode]> = [
    ['model', cmd.model ?? <span style={{ color: 'var(--fg-faint)' }}>—</span>],
    ['argument-hint', cmd.argumentHint ?? <span style={{ color: 'var(--fg-faint)' }}>—</span>],
    ['allowed-tools', allowed.length ? `${tools.length} tools · ${mcp.length} MCP` : <span style={{ color: 'var(--fg-faint)' }}>—</span>],
    ['file mtime', formatTime(cmd.modifiedMs)],
  ];
  return (
    <>
      <DetailHead
        filepath={cmd.path}
        onPathClick={onEdit}
        title={`/${cmd.name}`}
        scope={cmd.scope}
        description={cmd.description}
        actions={
          <>
            <IconButton onClick={() => onEdit(cmd.path)}><Edit3 size={11} /> Edit</IconButton>
            <IconButton variant="primary" onClick={() => onRun(cmd)}>
              <TermIcon size={11} /> Run /{cmd.name}
            </IconButton>
          </>
        }
      />
      <div className="ccfg-detail-body">
        <Section label="Frontmatter">
          <FrontmatterGrid entries={fmRows} />
        </Section>
        {tools.length > 0 && (
          <Section label="Allowed tools" count={`${tools.length}`}>
            <Chips values={tools} variant="tool" initial={tools.length > 8 ? 8 : undefined} />
          </Section>
        )}
        {mcp.length > 0 && (
          <Section label="MCP tools" count={`${mcp.length}`}>
            <Chips values={mcp} variant="mcp" />
          </Section>
        )}
        <Section
          label="Body · the prompt that runs"
          count={`${cmd.body.split('\n').length} lines`}
        >
          <pre className="ccfg-body-preview">{cmd.body}</pre>
        </Section>
      </div>
    </>
  );
}

// ─── Hook detail ───────────────────────────────────────────────────────────

interface HookDetailProps {
  hook: ClaudeHook;
  onEdit: (path: string) => void;
}
export function HookDetailView({ hook, onEdit }: HookDetailProps) {
  const [scriptBody, setScriptBody] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [loadAttempted, setLoadAttempted] = useState(false);

  function loadScript() {
    if (!hook.commandPath) return;
    setLoadAttempted(true);
    claudeConfigReadFile(hook.commandPath)
      .then(setScriptBody)
      .catch((e) => setScriptError(String(e)));
  }

  return (
    <>
      <DetailHead
        filepath={hook.commandPath ?? hook.settingsPath}
        onPathClick={onEdit}
        title={hook.name}
        scope={hook.scope}
        description={
          hook.commandPath
            ? `${hook.event} · type: ${hook.type} — script body resolved from ${shortPath(hook.commandPath)}`
            : `${hook.event} · type: ${hook.type}`
        }
        actions={
          hook.commandPath ? (
            <>
              <IconButton onClick={loadScript}>
                <RotateCcw size={11} /> {scriptBody ? 'Reload' : 'Load script'}
              </IconButton>
            </>
          ) : null
        }
      />
      <div className="ccfg-detail-body">
        <Section label="JSON entry · settings file">
          <pre className="ccfg-script">{JSON.stringify(hook.raw, null, 2)}</pre>
        </Section>
        <Section label="settings path">
          <FilePathLink
            path={hook.settingsPath}
            onClick={onEdit}
            className="ccfg-filepath"
          />
        </Section>
        {hook.commandPath && (
          <Section
            label="Script body"
            count={scriptBody ? `${scriptBody.split('\n').length} lines` : 'click Load script'}
          >
            {scriptBody ? (
              <pre className="ccfg-script">{scriptBody}</pre>
            ) : scriptError ? (
              <pre className="ccfg-script" style={{ color: 'var(--danger)' }}>{scriptError}</pre>
            ) : loadAttempted ? (
              <pre className="ccfg-script">loading…</pre>
            ) : (
              <div style={{ color: 'var(--fg-faint)', fontSize: 12 }}>
                Click "Load script" to read{' '}
                <FilePathLink
                  path={hook.commandPath}
                  onClick={onEdit}
                  className="ccfg-filepath"
                />
                .
              </div>
            )}
          </Section>
        )}
      </div>
    </>
  );
}

// ─── MCP detail ────────────────────────────────────────────────────────────

interface McpDetailProps {
  mcp: ClaudeMcp;
  onEdit: (path: string) => void;
}

export function McpDetailView({ mcp, onEdit }: McpDetailProps) {
  const isStdio = mcp.transport === 'stdio' || (!!mcp.command && !mcp.url);
  const fmRows: Array<[string, ReactNode]> = [
    ['name', mcp.name],
    ['transport', <TransportBadge transport={mcp.transport} />],
  ];
  if (isStdio) {
    fmRows.push(
      ['command', mcp.command ?? <span style={{ color: 'var(--fg-faint)' }}>—</span>],
      [
        'args',
        mcp.args.length ? (
          <span style={{ wordBreak: 'break-word' }}>{mcp.args.join(' ')}</span>
        ) : (
          <span style={{ color: 'var(--fg-faint)' }}>—</span>
        ),
      ],
    );
  } else {
    fmRows.push([
      'url',
      mcp.url ?? <span style={{ color: 'var(--fg-faint)' }}>—</span>,
    ]);
  }

  return (
    <>
      <DetailHead
        filepath={mcp.path}
        onPathClick={onEdit}
        title={mcp.name}
        scope={mcp.scope}
        description={
          isStdio
            ? `${mcp.transport} server · spawned by Claude Code on demand`
            : `${mcp.transport.toUpperCase()} server at ${mcp.url ?? '(no url)'}`
        }
        actions={<IconButton onClick={() => onEdit(mcp.path)}><Edit3 size={11} /> Edit</IconButton>}
      />
      <div className="ccfg-detail-body">
        <Section label="Config">
          <FrontmatterGrid entries={fmRows} />
        </Section>
        {mcp.envKeys.length > 0 && (
          <Section label="Env vars" count={`${mcp.envKeys.length}`}>
            <Chips values={mcp.envKeys} variant="tool" />
          </Section>
        )}
        {mcp.headerKeys.length > 0 && (
          <Section label="Headers" count={`${mcp.headerKeys.length}`}>
            <Chips values={mcp.headerKeys} variant="mcp" />
          </Section>
        )}
        <Section label="Raw entry">
          <pre className="ccfg-script">{JSON.stringify(mcp.raw, null, 2)}</pre>
        </Section>
      </div>
    </>
  );
}

function TransportBadge({ transport }: { transport: string }) {
  const variant =
    transport === 'http' || transport === 'sse'
      ? 'is-mcp'
      : transport === 'stdio'
        ? 'is-tool'
        : '';
  return <span className={cn('ccfg-chip', variant)}>{transport}</span>;
}

// ─── Section ───────────────────────────────────────────────────────────────

interface SectionProps {
  label: string;
  count?: string;
  children: ReactNode;
}
function Section({ label, count, children }: SectionProps) {
  return (
    <div className="ccfg-section">
      <div className="ccfg-section-label">
        <span>{label}</span>
        {count && <span className="ct">{count}</span>}
      </div>
      {children}
    </div>
  );
}
