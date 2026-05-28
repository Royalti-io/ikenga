// Verb-level tests for host.dbExec (local-store write-path WP).
//
// Covers the guard stack on the write bridge: statement allowlist
// (INSERT/UPDATE/DELETE only), the `capabilities.sqlite` gate, and the
// table-scope check against `permissions['sqlite.tables']`. The Rust `db_exec`
// is mocked at the `@/lib/tauri-cmd` boundary — this layer only proves the
// dispatcher's guards fire and that an allowed write threads sql+params through.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri-cmd', () => ({
	dbQuery: vi.fn(),
	dbExec: vi.fn(),
	pkgKernelStatus: vi.fn(),
	pkgPreviewManifest: vi.fn(),
	pkgContentHtml: vi.fn(),
	pkgContentRevoke: vi.fn(),
	pkgMcpCall: vi.fn(),
	pkgSidecarCall: vi.fn(),
}));

import { dbExec, pkgKernelStatus, pkgPreviewManifest } from '@/lib/tauri-cmd';
import { dispatchHostCall } from './pkg-iframe-host';

const kernelStatus = vi.mocked(pkgKernelStatus);
const previewManifest = vi.mocked(pkgPreviewManifest);
const exec = vi.mocked(dbExec);

const PKG = 'com.ikenga.tasks';

// Mount a manifest with an optional `sqlite` capability + a declared
// `sqlite.tables` allowlist.
function withManifest({ sqlite, tables }: { sqlite: boolean; tables: string[] }) {
	kernelStatus.mockResolvedValue({
		installed: [{ id: PKG, install_path: `/pkgs/${PKG}` }],
		registries: {},
		api_version: 1,
	} as never);
	previewManifest.mockResolvedValue({
		id: PKG,
		name: PKG,
		version: '1.0.0',
		ikenga_api: '1',
		capabilities: sqlite ? { sqlite: { db: 'ikenga.local' } } : {},
		permissions: { 'sqlite.tables': tables },
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('host.dbExec (pkg-iframe write path)', () => {
	it('runs an allowed UPDATE on a declared table and threads sql+params', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });
		exec.mockResolvedValue(undefined as never);

		const sql = 'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?';
		const params = ['completed', '2026-05-28T00:00:00.000Z', 'task-1'];
		const res = await dispatchHostCall(PKG, 'host.dbExec', { sql, params });

		expect(exec).toHaveBeenCalledWith(sql, params);
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toEqual({ ok: true });
	});

	it('rejects SELECT statements (reads belong on host.dbQuery)', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbExec', {
			sql: 'SELECT * FROM tasks',
		});

		expect(res.isError).toBe(true);
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects DDL / dangerous statements', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		for (const sql of ['DROP TABLE tasks', 'PRAGMA journal_mode', 'ATTACH DATABASE x AS y']) {
			const res = await dispatchHostCall(PKG, 'host.dbExec', { sql });
			expect(res.isError).toBe(true);
		}
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects when the pkg lacks the sqlite capability', async () => {
		withManifest({ sqlite: false, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbExec', {
			sql: 'UPDATE tasks SET status = ? WHERE id = ?',
			params: ['blocked', 'task-1'],
		});

		expect(res.isError).toBe(true);
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects a write to a table outside the declared sqlite.tables', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbExec', {
			sql: 'DELETE FROM revenue WHERE id = ?',
			params: ['r-1'],
		});

		expect(res.isError).toBe(true);
		expect(exec).not.toHaveBeenCalled();
	});

	it('rejects a missing sql argument', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbExec', {});

		expect(res.isError).toBe(true);
		expect(exec).not.toHaveBeenCalled();
	});
});
