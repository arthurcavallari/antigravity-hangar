/**
 * @fileoverview Debounced idle-TTL process hibernation & auto-wake manager.
 *
 * Decouples 0ms tab visibility from background process lifecycle so switching
 * chat tabs across repositories does not immediately kill or cold-start sidecars.
 */

export class HibernationManager {
  #lastActiveAt = new Map();
  #manualStopSet = new Set();
  #inFlightActions = new Set();

  constructor() {}

  markManualStop(sidecarId, stopped = true) {
    if (stopped) {
      this.#manualStopSet.add(sidecarId);
    } else {
      this.#manualStopSet.delete(sidecarId);
    }
  }

  // Replaces the in-memory set with the stops persisted in hangar.json, so they survive restarts
  syncManualStops(sidecarIds = []) {
    this.#manualStopSet = new Set(sidecarIds);
  }

  isManuallyStopped(sidecarId) {
    return this.#manualStopSet.has(sidecarId);
  }

  getIdleSeconds(sidecarId, nowMs = Date.now()) {
    const last = this.#lastActiveAt.get(sidecarId);
    if (!last) return 0;
    return Math.max(0, Math.floor((nowMs - last) / 1000));
  }

  async reconcile(
    sidecars = [],
    {
      hibernateAfterIdleMinutes = 10,
      nowMs = Date.now(),
      manageSidecarFn,
    } = {}
  ) {
    const actionsTriggered = [];
    const idleThresholdMs = Math.max(1, Number(hibernateAfterIdleMinutes) || 10) * 60 * 1000;

    for (const sc of sidecars) {
      const id = sc.sidecarId;
      if (!id || this.#inFlightActions.has(id)) continue;

      if (sc.matchesWorkspace) {
        this.#lastActiveAt.set(id, nowMs);
        // Auto-wake stopped sidecars that match the active workspace (unless manually stopped)
        if (
          sc.status === 'SIDECAR_STATUS_STOPPED' &&
          sc.autoHibernate &&
          !this.#manualStopSet.has(id) &&
          typeof manageSidecarFn === 'function'
        ) {
          this.#inFlightActions.add(id);
          try {
            await manageSidecarFn('SIDECAR_ACTION_ENABLE', id);
            actionsTriggered.push({ sidecarId: id, action: 'SIDECAR_ACTION_ENABLE', reason: 'workspace_match' });
          } catch {
            // Non-fatal; next poll will retry
          } finally {
            this.#inFlightActions.delete(id);
          }
        }
        continue;
      }

      // Sidecar does not match the current workspace
      if (!this.#lastActiveAt.has(id)) {
        this.#lastActiveAt.set(id, nowMs);
        continue;
      }

      const idleMs = nowMs - this.#lastActiveAt.get(id);
      if (
        sc.autoHibernate &&
        sc.status === 'SIDECAR_STATUS_RUNNING' &&
        idleMs >= idleThresholdMs &&
        typeof manageSidecarFn === 'function'
      ) {
        this.#inFlightActions.add(id);
        try {
          await manageSidecarFn('SIDECAR_ACTION_DISABLE', id);
          actionsTriggered.push({
            sidecarId: id,
            action: 'SIDECAR_ACTION_DISABLE',
            reason: 'idle_ttl_expired',
            idleSeconds: Math.round(idleMs / 1000),
          });
        } catch {
          // Non-fatal
        } finally {
          this.#inFlightActions.delete(id);
        }
      }
    }

    return actionsTriggered;
  }
}

export const defaultHibernator = new HibernationManager();
