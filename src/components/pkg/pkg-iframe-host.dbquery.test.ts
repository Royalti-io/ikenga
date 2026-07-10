// Verb-level tests for host.dbQuery (local-store read-path, WP-04 + WP-09
// table scoping).
//
// Covers the guard stack on the read bridge: statement allowlist (SELECT/WITH
// only), the `capabilities.sqlite` gate, and the table-scope check against
// `permissions['sqlite.tables']` (the read-path analogue of host.dbExec's write
// scope). The Rust `db_query` is mocked at the `@/lib/tauri-cmd` boundary — this
// layer only proves the dispatcher's guards fire and that an allowed read
// threads sql+params through. Also directly unit-tests `readSourceTables`.

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

import { dbQuery, pkgKernelStatus, pkgPreviewManifest } from '@/lib/tauri-cmd';
import { dispatchHostCall, readSourceTables } from './pkg-iframe-host';

const kernelStatus = vi.mocked(pkgKernelStatus);
const previewManifest = vi.mocked(pkgPreviewManifest);
const query = vi.mocked(dbQuery);

const PKG = 'com.ikenga.tasks';

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

describe('host.dbQuery (pkg-iframe read path)', () => {
	it('runs an allowed SELECT on a declared table and threads sql+params', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });
		query.mockResolvedValue([{ id: 'task-1' }] as never);

		const sql = 'SELECT id, status FROM tasks WHERE status = ?';
		const params = ['open'];
		const res = await dispatchHostCall(PKG, 'host.dbQuery', { sql, params });

		expect(query).toHaveBeenCalledWith(sql, params);
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toEqual({ ok: true, rows: [{ id: 'task-1' }] });
	});

	it('allows a JOIN when every source table is declared', async () => {
		withManifest({ sqlite: true, tables: ['tasks', 'sales_deals'] });
		query.mockResolvedValue([] as never);

		const sql =
			'SELECT t.id FROM tasks t JOIN sales_deals d ON d.task_id = t.id WHERE d.stage = ?';
		const res = await dispatchHostCall(PKG, 'host.dbQuery', { sql, params: ['won'] });

		expect(query).toHaveBeenCalledWith(sql, ['won']);
		expect(res.isError).toBeUndefined();
	});

	it('allows a WITH/CTE read (CTE name is not treated as a real table)', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });
		query.mockResolvedValue([] as never);

		const sql = 'WITH recent AS (SELECT * FROM tasks) SELECT * FROM recent';
		const res = await dispatchHostCall(PKG, 'host.dbQuery', { sql });

		expect(query).toHaveBeenCalledWith(sql, []);
		expect(res.isError).toBeUndefined();
	});

	it('rejects INSERT/UPDATE/DELETE statements (writes belong on host.dbExec)', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		for (const sql of [
			'UPDATE tasks SET status = ?',
			'DELETE FROM tasks',
			'INSERT INTO tasks (id) VALUES (?)',
		]) {
			const res = await dispatchHostCall(PKG, 'host.dbQuery', { sql });
			expect(res.isError).toBe(true);
		}
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects when the pkg lacks the sqlite capability', async () => {
		withManifest({ sqlite: false, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbQuery', {
			sql: 'SELECT * FROM tasks',
		});

		expect(res.isError).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects a read of a table outside the declared sqlite.tables', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbQuery', {
			sql: 'SELECT * FROM revenue',
		});

		expect(res.isError).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects a JOIN when one source table is out of scope', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbQuery', {
			sql: 'SELECT * FROM tasks t JOIN revenue r ON r.id = t.id',
		});

		expect(res.isError).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects a SELECT with no identifiable source table', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbQuery', { sql: 'SELECT 1' });

		expect(res.isError).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects a missing sql argument', async () => {
		withManifest({ sqlite: true, tables: ['tasks'] });

		const res = await dispatchHostCall(PKG, 'host.dbQuery', {});

		expect(res.isError).toBe(true);
		expect(query).not.toHaveBeenCalled();
	});
});

describe('readSourceTables', () => {
	it('extracts a single FROM table', () => {
		expect(readSourceTables('SELECT * FROM tasks')).toEqual(['tasks']);
	});

	it('extracts FROM + JOIN tables, ignoring aliases', () => {
		expect(
			readSourceTables('SELECT t.id FROM tasks t JOIN sales_deals d ON d.task_id = t.id')
		).toEqual(['tasks', 'sales_deals']);
	});

	it('strips quoting/bracketing around table names', () => {
		expect(readSourceTables('SELECT * FROM "tasks"')).toEqual(['tasks']);
		expect(readSourceTables('SELECT * FROM [tasks]')).toEqual(['tasks']);
	});

	it('excludes CTE names but keeps the real inner table', () => {
		expect(
			readSourceTables('WITH recent AS (SELECT * FROM tasks) SELECT * FROM recent')
		).toEqual(['tasks']);
	});

	it('picks up the inner table of a subquery source', () => {
		expect(readSourceTables('SELECT * FROM (SELECT * FROM tasks) x')).toEqual(['tasks']);
	});

	it('de-duplicates repeated tables (case-insensitively)', () => {
		expect(
			readSourceTables('SELECT * FROM tasks a JOIN Tasks b ON a.id = b.parent_id')
		).toEqual(['tasks']);
	});

	it('returns [] for a table-less SELECT', () => {
		expect(readSourceTables('SELECT 1')).toEqual([]);
	});
});
