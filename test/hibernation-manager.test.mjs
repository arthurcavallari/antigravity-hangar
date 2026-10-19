import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HibernationManager } from '../lib/hibernation-manager.mjs';

describe('HibernationManager debounced idle-TTL lifecycle', () => {
  it('does not disable an inactive sidecar before hibernateAfterIdleMinutes expires', async () => {
    const hib = new HibernationManager();
    const calls = [];
    const t0 = 1_700_000_000_000;

    // 1. First observation when inactive starts the idle clock
    await hib.reconcile(
      [
        {
          sidecarId: 'db-inspector',
          status: 'SIDECAR_STATUS_RUNNING',
          autoHibernate: true,
          matchesWorkspace: false,
        },
      ],
      {
        hibernateAfterIdleMinutes: 10,
        nowMs: t0,
        manageSidecarFn: async (action, id) => calls.push({ action, id }),
      }
    );
    assert.equal(calls.length, 0);

    // 2. 5 minutes later (< 10 min TTL): still running, no disable call
    await hib.reconcile(
      [
        {
          sidecarId: 'db-inspector',
          status: 'SIDECAR_STATUS_RUNNING',
          autoHibernate: true,
          matchesWorkspace: false,
        },
      ],
      {
        hibernateAfterIdleMinutes: 10,
        nowMs: t0 + 5 * 60 * 1000,
        manageSidecarFn: async (action, id) => calls.push({ action, id }),
      }
    );
    assert.equal(calls.length, 0);

    // 3. 11 minutes later (>= 10 min TTL): triggers SIDECAR_ACTION_DISABLE
    await hib.reconcile(
      [
        {
          sidecarId: 'db-inspector',
          status: 'SIDECAR_STATUS_RUNNING',
          autoHibernate: true,
          matchesWorkspace: false,
        },
      ],
      {
        hibernateAfterIdleMinutes: 10,
        nowMs: t0 + 11 * 60 * 1000,
        manageSidecarFn: async (action, id) => calls.push({ action, id }),
      }
    );
    assert.deepEqual(calls, [{ action: 'SIDECAR_ACTION_DISABLE', id: 'db-inspector' }]);
  });

  it('auto-wakes a stopped autoHibernate sidecar when its workspace becomes active', async () => {
    const hib = new HibernationManager();
    const calls = [];

    await hib.reconcile(
      [
        {
          sidecarId: 'db-inspector',
          status: 'SIDECAR_STATUS_STOPPED',
          autoHibernate: true,
          matchesWorkspace: true,
        },
      ],
      {
        hibernateAfterIdleMinutes: 10,
        nowMs: Date.now(),
        manageSidecarFn: async (action, id) => calls.push({ action, id }),
      }
    );
    assert.deepEqual(calls, [{ action: 'SIDECAR_ACTION_ENABLE', id: 'db-inspector' }]);
  });
});
