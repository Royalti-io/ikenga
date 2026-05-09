#!/usr/bin/env bun
//
// iyke-mcp — MCP server that exposes the Ikenga desktop app's Iyke
// control bridge to Claude. Tools mirror the `iyke` CLI subcommands so
// a Claude session in any terminal can drive the app the same way a
// developer types into iyke at a shell.
//
// Trust boundary is the localhost HTTP server inside the desktop app:
// we read control.json (port + bearer token) the same way the CLI does
// and forward calls. If the app isn't running, every tool fails with a
// structured error rather than hanging — Claude sees the failure and
// reports it instead of silently waiting.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { IykeClient } from './api.ts';
import { load, STALE_THRESHOLD_SECS } from './control.ts';

const ACTIVITY_MODES = [
  'app',
  'files',
  'agents',
  'sessions',
  'settings',
  'storyboard',
  'video-engine',
  'canvas-design',
  'image-generator',
] as const;

const MINI_APP_NAMES = [
  'storyboard',
  'video-engine',
  'canvas-design',
  'image-generator',
] as const;

const TOOLS = [
  {
    name: 'iyke_state',
    description:
      'Get the current state of the Ikenga desktop app — sidebar mode, focused pane route, and the full pane tree under shell.panes. shell.panes has shape { leaves: [{ id, focused, activeTabIdx, tabs: [{kind,title}] }], tree: <recursive PaneNode> }; use leaves[].id with iyke_focus or iyke_close (pane_id) to operate on a specific pane. Call this before iyke_go / iyke_mode / iyke_focus / iyke_close to check what the user is currently looking at.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'iyke_go',
    description:
      'Navigate the focused pane to a route path inside the PA app (e.g. "/finance/receivables"). Path must start with "/". This replaces the focused pane\'s active tab content; use iyke_open with kind=route to add a new tab instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Route path, must start with "/".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_mode',
    description:
      'Switch the activity-bar sidebar mode. Valid modes: app, files, agents, sessions, settings, storyboard, video-engine, canvas-design, image-generator. The first five are core; the rest are mini-apps.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: [...ACTIVITY_MODES] },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_open',
    description:
      'Open a new tab in the focused pane. `kind` selects the view type. For "route" pass `path`; "terminal" optionally `cmd` (a shell command string); "chat" requires `session_id`; "artifact" requires `path`; "mini-app" requires `name`.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['route', 'terminal', 'chat', 'artifact', 'mini-app'],
        },
        path: { type: 'string', description: 'For route or artifact kinds.' },
        cmd: { type: 'string', description: 'For terminal kind. Omit for default login shell.' },
        session_id: { type: 'string', description: 'For chat kind.' },
        name: {
          type: 'string',
          enum: [...MINI_APP_NAMES],
          description: 'For mini-app kind.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_split',
    description:
      'Split the focused pane (or a specific pane via pane_id) into two. "horizontal" splits side-by-side; "vertical" splits top-bottom. Subject to the in-app MAX_LEAVES cap (currently 6).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['horizontal', 'vertical'] },
        pane_id: { type: 'string', description: 'Optional. Defaults to focused pane.' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_focus',
    description:
      'Focus a specific pane. Provide either pane_id (leaf id from iyke_state response — shell.panes.leaves[].id) or index (1-based DFS leaf index, matching the in-app ⌃1..⌃6 keyboard shortcuts).',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string' },
        index: { type: 'integer', minimum: 1, maximum: 6 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_close',
    description:
      'Close a pane (or the focused pane if pane_id omitted). Closes the entire pane and all its tabs — to close a single tab from the in-app keyboard, use ⌘⇧W (⌘W closes the whole pane). Refuses to close the last remaining pane.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'string', description: 'Optional. Defaults to focused pane.' },
      },
      additionalProperties: false,
    },
  },
  // Phase A — runtime inspection + driving.
  {
    name: 'iyke_dom',
    description:
      'Take an accessibility-tree snapshot of the focused pane. Returns Playwright-style text plus structured JSON. Each interactive element gets a stable ref like e1, e2; pass that ref to iyke_click / iyke_type / iyke_key. Refs invalidate on the next snapshot or page navigation. Use `query` for substring filter, `all=true` to include hidden elements.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring filter against role/name/value.' },
        all: { type: 'boolean', description: 'Include hidden + aria-hidden elements.' },
        pane: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_logs',
    description:
      'Read recent console + error logs (last 500) from the running webview. Includes window error and unhandledrejection captures.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['log', 'info', 'warn', 'error', 'debug'],
        },
        since: { type: 'integer', description: 'Only entries with ts >= this (epoch ms).' },
        source: { type: 'string', description: 'Filter by pane source ("shell" or leaf id).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_network',
    description:
      'Read recent fetch + XHR network activity (last 100). Each entry has method, url, status, duration_ms, and error if it failed.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer' },
        source: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_screenshot',
    description:
      'Capture a PNG screenshot of either the full window or a specific pane. Returns the saved path, dimensions, and byte count. Default writes to ~/.local/share/ikenga/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['window', 'pane'], default: 'window' },
        pane_id: { type: 'string', description: 'Required when target=pane.' },
        out_path: { type: 'string', description: 'Override default output path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_wait',
    description:
      'Wait until a predicate is satisfied or timeout. Use this after iyke_click / iyke_go to wait for the new state to render, instead of fixed sleeps. Returns { satisfied, elapsed_ms, message? }.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['text', 'selector', 'ref', 'gone-text', 'gone-selector'],
        },
        value: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 10000 },
        pane: { type: 'string' },
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_click',
    description:
      'Click an element. Specify exactly one of `ref` (from iyke_dom), `selector` (CSS), or `text` (innerText match). Refs are most reliable.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        pane: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_type',
    description:
      'Type text into an input/textarea/contenteditable element. Specify exactly one of `ref` or `selector`. By default appends; pass `replace=true` to overwrite the existing value.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        replace: { type: 'boolean', default: false },
        pane: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_key',
    description:
      'Dispatch a keyboard combo. Use names like "Enter", "Escape", "Tab", "ArrowDown", and modifiers Ctrl/Alt/Shift/Meta separated by + or , (e.g. "Ctrl+S", "Meta+K"). Optional `ref`/`selector` targets a specific element; otherwise the active element receives.',
    inputSchema: {
      type: 'object',
      properties: {
        combo: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        pane: { type: 'string' },
      },
      required: ['combo'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_query_cache',
    description:
      'Dump the TanStack Query cache: queryKey, status, fetchStatus, isStale, dataUpdatedAt, errorUpdatedAt, error, and a 200-char data preview for each entry. Useful for diagnosing stale data or failed fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_devtools',
    description:
      'Open Chrome DevTools for the main webview (debug builds only). Returns 503 in production builds.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // Phase C — iframe runtime state.
  {
    name: 'iyke_iframe_state',
    description:
      'Read the latest published state object for an iframe pane (storyboard cursor, comp current frame, etc.). Iframes call publishState(key, value) from their iyke-bridge to expose runtime state for inspection.',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string' } },
      required: ['pane'],
      additionalProperties: false,
    },
  },
  {
    name: 'iyke_iframe_send',
    description:
      'Send a fire-and-forget postMessage to an iframe pane. The iframe bridge listens for known kinds (e.g. "story-select") and acts on the payload. Use to drive mini-app actions from outside the running app.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        kind: { type: 'string' },
        payload: {},
      },
      required: ['pane', 'kind'],
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]['name'];

function getClient(): IykeClient {
  const outcome = load();
  switch (outcome.kind) {
    case 'ok':
      return new IykeClient(outcome.control);
    case 'missing':
      throw new McpError(
        ErrorCode.InternalError,
        'PA desktop app does not appear to be running (no control.json found).',
      );
    case 'stale-removed':
      throw new McpError(
        ErrorCode.InternalError,
        'PA desktop app does not appear to be running (cleared a stale control.json from a previous launch).',
      );
    case 'stale-young':
      throw new McpError(
        ErrorCode.InternalError,
        `control.json exists but its PID is dead and the file is only ${outcome.ageSecs}s old (threshold ${STALE_THRESHOLD_SECS}s). The app may be launching or in a startup race; retry shortly.`,
      );
  }
}

async function dispatch(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const client = getClient();
  switch (name) {
    case 'iyke_state':
      return client.get('/iyke/state');
    case 'iyke_go':
      return client.post('/iyke/go', { path: args.path });
    case 'iyke_mode':
      return client.post('/iyke/mode', { mode: args.mode });
    case 'iyke_open':
      return client.post('/iyke/open', args);
    case 'iyke_split':
      return client.post('/iyke/split', {
        direction: args.direction,
        pane_id: args.pane_id ?? null,
      });
    case 'iyke_focus':
      return client.post('/iyke/focus', {
        pane_id: args.pane_id ?? null,
        index: args.index ?? null,
      });
    case 'iyke_close':
      return client.post('/iyke/close', { pane_id: args.pane_id ?? null });
    case 'iyke_dom':
      return client.get('/iyke/dom', {
        query: args.query,
        all: args.all,
        pane: args.pane,
      });
    case 'iyke_logs':
      return client.get('/iyke/logs', {
        level: args.level,
        since: args.since,
        source: args.source,
      });
    case 'iyke_network':
      return client.get('/iyke/network', {
        since: args.since,
        source: args.source,
      });
    case 'iyke_screenshot': {
      const target = (args.target as string) ?? 'window';
      const path = target === 'pane' ? '/iyke/screenshot/pane' : '/iyke/screenshot/window';
      const body: Record<string, unknown> = {};
      if (args.out_path !== undefined) body.out_path = args.out_path;
      if (target === 'pane') {
        if (!args.pane_id) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'pane_id required when target=pane',
          );
        }
        body.pane_id = args.pane_id;
      }
      return client.post(path, body, 15000);
    }
    case 'iyke_wait': {
      const timeoutMs =
        typeof args.timeout_ms === 'number' ? args.timeout_ms : 10_000;
      return client.post(
        '/iyke/wait',
        {
          kind: args.kind,
          value: args.value,
          timeout_ms: timeoutMs,
          pane: args.pane ?? null,
        },
        timeoutMs + 2_000,
      );
    }
    case 'iyke_click':
      return client.post('/iyke/click', {
        ref: args.ref ?? null,
        selector: args.selector ?? null,
        text: args.text ?? null,
        pane: args.pane ?? null,
      });
    case 'iyke_type':
      return client.post('/iyke/type', {
        ref: args.ref ?? null,
        selector: args.selector ?? null,
        text: args.text,
        replace: args.replace === true,
        pane: args.pane ?? null,
      });
    case 'iyke_key':
      return client.post('/iyke/key', {
        combo: args.combo,
        ref: args.ref ?? null,
        selector: args.selector ?? null,
        pane: args.pane ?? null,
      });
    case 'iyke_query_cache':
      return client.get('/iyke/query-cache', { pane: args.pane });
    case 'iyke_devtools':
      return client.post('/iyke/devtools', {});
    case 'iyke_iframe_state':
      return client.get('/iyke/iframe-state', { pane: args.pane });
    case 'iyke_iframe_send':
      return client.post('/iyke/iframe-message', {
        pane: args.pane,
        kind: args.kind,
        payload: args.payload ?? null,
      });
  }
}

async function main() {
  const server = new Server(
    { name: 'iyke-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!TOOLS.some((t) => t.name === name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await dispatch(name as ToolName, (args ?? {}) as Record<string, unknown>);
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      if (err instanceof McpError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Surface as a normal tool result with isError so Claude can read
      // and react instead of treating it as a transport-level failure.
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('iyke-mcp fatal:', err);
  process.exit(1);
});
