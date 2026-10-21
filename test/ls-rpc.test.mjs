import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hangarRpc, invalidateStateReads } from '../lib/ls-rpc.mjs';

describe('hangarRpc shared state reads', () => {
  it('shares GetSidecars/GetAllCascadeTrajectories between windows and drops GetSidecars after a write', async () => {
    const calls = {};
    const options = {
      lsAddress: '127.0.0.1:59990',
      csrfToken: 'tok',
      fetchFn: async (url) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        calls[method] = (calls[method] || 0) + 1;
        return { ok: true, status: 200, text: async () => '{}' };
      },
    };
    invalidateStateReads();
    // Two Hangar windows polling /api/state at once
    const poll = () =>
      Promise.all([hangarRpc('GetSidecars', {}, options), hangarRpc('GetAllCascadeTrajectories', {}, options)]);
    await Promise.all([poll(), poll()]);
    await poll();
    assert.deepEqual(calls, { GetSidecars: 1, GetAllCascadeTrajectories: 1 });

    // Writes are never merged or cached, and the next poll sees the new sidecar status
    await hangarRpc('ManageSidecar', { action: 'SIDECAR_ACTION_STOP', sidecarId: 'x' }, options);
    await hangarRpc('ManageSidecar', { action: 'SIDECAR_ACTION_STOP', sidecarId: 'x' }, options);
    await poll();
    assert.deepEqual(calls, { GetSidecars: 2, GetAllCascadeTrajectories: 1, ManageSidecar: 2 });

    invalidateStateReads();
    await poll();
    assert.deepEqual(calls, { GetSidecars: 3, GetAllCascadeTrajectories: 2, ManageSidecar: 2 });
  });
});
