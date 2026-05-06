// Spike: dynamic Tauri ACL verification driven by iyke.
//
// On mount, runs the 3-step test:
//   1. Read /tmp/spike-test.txt without grant — should fail.
//   2. Call spike_grant_fs_read to add a runtime capability for that path.
//   3. Read again — should succeed.
//
// Results render as text rows so iyke can `wait text "STEP3 OK"` and
// `logs` captures the full sequence. Delete this route after the kernel lands.
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { spikeGrantFsRead } from '@/lib/tauri-cmd';

// Hit the fs plugin directly. plugin-fs's read_text_file returns a
// `tauri::ipc::Response` (binary) — when invoked without the JS wrapper it
// arrives as an ArrayBuffer. We decode it ourselves so we can verify the
// file body, not just that the call succeeded.
const readTextFile = async (path: string): Promise<string> => {
  const buf = await invoke<ArrayBuffer>('plugin:fs|read_text_file', { path });
  return new TextDecoder().decode(buf);
};

export const Route = createFileRoute('/spike-acl')({
  component: SpikeAcl,
});

// Use a fresh path per mount so prior in-process grants don't leak.
// add_capability has no removal counterpart, so once granted a path stays
// granted until the process dies — meaning a stable TEST_PATH would always
// pass STEP1 on the second navigation. A new path proves each cycle.
const TEST_PATH = `/tmp/spike-test-${Date.now()}.txt`;

type Row = { label: string; outcome: string };

function SpikeAcl() {
  const [rows, setRows] = useState<Row[]>([]);
  const [verdict, setVerdict] = useState<string>('RUNNING');

  useEffect(() => {
    let cancelled = false;
    const capId = `spike.fs-read.${Date.now()}`;
    const log = (label: string, outcome: string) => {
      if (cancelled) return;
      // eslint-disable-next-line no-console
      console.log(`[spike-acl] ${label}: ${outcome}`);
      setRows((prev) => [...prev, { label, outcome }]);
    };

    (async () => {
      // Setup: stage the test file via the spike Rust command (uses std::fs,
      // no Tauri ACL involved on the Rust side, so we can write anywhere).
      const expected = `spike OK ${Date.now()}\n`;
      try {
        await invoke<void>('spike_setup_test_file', { path: TEST_PATH, body: expected });
        log('SETUP', `WROTE ${TEST_PATH}`);
      } catch (e) {
        log('SETUP', `SETUP_FAIL ${(e as Error).message ?? String(e)}`);
        setVerdict('VERDICT FAIL (setup)');
        return;
      }

      // Step 1: read without grant — expect failure.
      let step1Blocked = false;
      try {
        const body = await readTextFile(TEST_PATH);
        log('STEP1', `UNEXPECTED_OK body=${JSON.stringify(body)}`);
      } catch (e) {
        step1Blocked = true;
        log('STEP1', `BLOCKED_AS_EXPECTED ${(e as Error).message ?? String(e)}`);
      }

      // Step 2: grant runtime capability.
      let step2Granted = false;
      try {
        const msg = await spikeGrantFsRead(capId, TEST_PATH);
        step2Granted = true;
        log('STEP2', `GRANT_OK ${msg}`);
      } catch (e) {
        log('STEP2', `GRANT_FAIL ${(e as Error).message ?? String(e)}`);
      }

      // Step 3: read after grant — expect success and matching body.
      let step3Read = false;
      try {
        const body = await readTextFile(TEST_PATH);
        if (body === expected) {
          step3Read = true;
          log('STEP3', `READ_OK body_matches len=${body.length}`);
        } else {
          log('STEP3', `READ_OK_BUT_BODY_MISMATCH got=${JSON.stringify(body)}`);
        }
      } catch (e) {
        log('STEP3', `READ_FAIL ${(e as Error).message ?? String(e)}`);
      }

      const ok = step1Blocked && step2Granted && step3Read;
      const v = ok ? 'VERDICT PASS' : 'VERDICT FAIL';
      log('DONE', v);
      if (!cancelled) setVerdict(v);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: 'monospace', fontSize: 13 }}>
      <h1 style={{ fontSize: 16, marginBottom: 12 }}>Spike: Dynamic Tauri ACL</h1>
      <div data-testid="spike-verdict" style={{ marginBottom: 16, fontWeight: 'bold' }}>
        {verdict}
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((r, i) => (
          <li key={i} data-testid={`spike-row-${r.label}`}>
            <strong>{r.label}</strong> — {r.outcome}
          </li>
        ))}
      </ul>
    </div>
  );
}
