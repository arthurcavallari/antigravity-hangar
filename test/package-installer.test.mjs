import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectSidecarDirectory,
  installRemoteSidecar,
  linkLocalSidecar,
  selfUpdateHangar,
  uninstallSidecar,
} from '../lib/package-installer.mjs';
import { loadHangarConfig, readJsonSafe, writeJsonNoBom } from '../lib/config-store.mjs';

describe('Hangar package installer, local linker, and capability inspector', () => {
  it('classifies capability tiers and detects lifecycle scripts accurately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-inspect-test-'));
    try {
      // 1. Tier 1 Telemetry sidecar (setup.mjs uses child_process, server.mjs does not)
      const t1Dir = join(dir, 'antigravity-telemetry-demo');
      mkdirSync(t1Dir, { recursive: true });
      writeJsonNoBom(join(t1Dir, 'sidecar.json'), {
        command: 'node',
        args: ['server.mjs'],
        display_name: 'Telemetry Demo',
        version: '2.1.0',
      });
      writeFileSync(join(t1Dir, 'setup.mjs'), 'import { execFileSync } from "node:child_process";', 'utf8');
      writeFileSync(join(t1Dir, 'server.mjs'), 'import { SidecarApp } from "sidecar_sdk";', 'utf8');

      const info1 = inspectSidecarDirectory(t1Dir);
      assert.equal(info1.id, 'telemetry-demo');
      assert.equal(info1.version, '2.1.0');
      assert.equal(info1.capabilityTier, 'TIER_1_TELEMETRY');
      assert.equal(info1.hasLifecycleScripts, false);

      // 2. Tier 2 Local Tooling sidecar (runtime lib imports child_process)
      const t2Dir = join(dir, 'docker-helper');
      mkdirSync(join(t2Dir, 'lib'), { recursive: true });
      writeJsonNoBom(join(t2Dir, 'sidecar.json'), {
        command: 'node',
        args: ['server.mjs'],
        display_name: 'Docker Helper',
      });
      writeJsonNoBom(join(t2Dir, 'package.json'), {
        name: 'docker-helper',
        version: '1.4.0',
        scripts: { postinstall: 'node evil.js' },
      });
      writeFileSync(join(t2Dir, 'lib', 'cli.mjs'), 'import { spawn } from "node:child_process";', 'utf8');

      const info2 = inspectSidecarDirectory(t2Dir);
      assert.equal(info2.capabilityTier, 'TIER_2_LOCAL_TOOLING');
      assert.equal(info2.hasLifecycleScripts, true);
      assert.equal(info2.version, '1.4.0');

      // 3. Tier 3 Agent Control sidecar inside nested ui/components/ (invokes sidecar.agent.sendMessage)
      const t3Dir = join(dir, 'agent-pilot');
      mkdirSync(join(t3Dir, 'ui', 'components'), { recursive: true });
      writeJsonNoBom(join(t3Dir, 'sidecar.json'), {
        command: 'node',
        args: ['server.mjs'],
        display_name: 'Agent Pilot',
      });
      writeFileSync(
        join(t3Dir, 'ui', 'components', 'panel.js'),
        'window.sidecar.agent.sendMessage({ text: "fix build" });',
        'utf8'
      );

      const info3 = inspectSidecarDirectory(t3Dir);
      assert.equal(info3.capabilityTier, 'TIER_3_AGENT_CONTROL');

      // 4. First-party SDK dependency (antigravity-sidecar-kit) counts toward dependenciesCount
      // for npm install, but reports externalDependencies === 0 for security badges
      writeJsonNoBom(join(t1Dir, 'package.json'), {
        name: 'antigravity-telemetry-demo',
        version: '2.1.0',
        dependencies: {
          'antigravity-sidecar-kit': '^1.0.0',
        },
      });
      const infoSdk = inspectSidecarDirectory(t1Dir);
      assert.equal(infoSdk.dependenciesCount, 1);
      assert.equal(infoSdk.externalDependencies, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('links a local sidecar, updates hangar.json, and preserves projectId on uninstall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-link-test-'));
    try {
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');
      const hangarCfgPath = join(dir, 'hangar.json');
      const agyCfgPath = join(dir, 'config.json');
      const sampleSidecarDir = join(dir, 'my-custom-sidecar');

      mkdirSync(sampleSidecarDir, { recursive: true });
      writeJsonNoBom(join(sampleSidecarDir, 'sidecar.json'), {
        command: 'node',
        args: ['server.mjs'],
        display_name: 'My Custom Sidecar',
      });
      writeJsonNoBom(agyCfgPath, {
        sidecars: {
          'my-custom-sidecar': {
            enabled: false,
            projectId: 'existing-jetbox-uuid-1234',
          },
        },
      });

      const rpcCalls = [];
      const mockRpc = async (method, payload) => {
        rpcCalls.push({ method, payload });
        return { ok: true };
      };

      const linked = await linkLocalSidecar({
        folderPath: sampleSidecarDir,
        scope: 'project',
        workspaces: ['C:/Projects/Demo'],
        sidecarsDir,
        configPath: hangarCfgPath,
        agyConfigPath: agyCfgPath,
        rpcFn: mockRpc,
        delayMs: 0,
      });

      assert.equal(linked.ok, true);
      assert.equal(linked.sidecarId, 'my-custom-sidecar');
      assert.equal(existsSync(join(sidecarsDir, 'my-custom-sidecar', 'sidecar.json')), true);

      const hangarCfgAfterLink = loadHangarConfig(hangarCfgPath);
      assert.equal(hangarCfgAfterLink.sidecars['my-custom-sidecar'].source, 'local');
      assert.deepEqual(hangarCfgAfterLink.sidecars['my-custom-sidecar'].workspaces, ['C:/Projects/Demo']);

      const agyCfgAfterLink = readJsonSafe(agyCfgPath, {});
      assert.equal(agyCfgAfterLink.sidecars['my-custom-sidecar'].enabled, true);
      assert.equal(agyCfgAfterLink.sidecars['my-custom-sidecar'].projectId, 'existing-jetbox-uuid-1234');

      // Uninstall and verify junction is removed while projectId in config.json is preserved
      await uninstallSidecar({
        sidecarId: 'my-custom-sidecar',
        packagesDir,
        sidecarsDir,
        configPath: hangarCfgPath,
        agyConfigPath: agyCfgPath,
        rpcFn: mockRpc,
      });

      assert.equal(existsSync(join(sidecarsDir, 'my-custom-sidecar')), false);
      const hangarCfgAfterUninstall = loadHangarConfig(hangarCfgPath);
      assert.equal(hangarCfgAfterUninstall.sidecars['my-custom-sidecar'], undefined);

      const agyCfgAfterUninstall = readJsonSafe(agyCfgPath, {});
      assert.equal(agyCfgAfterUninstall.sidecars['my-custom-sidecar'].enabled, false);
      assert.equal(
        agyCfgAfterUninstall.sidecars['my-custom-sidecar'].projectId,
        'existing-jetbox-uuid-1234'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs a remote GitHub sidecar (including owner/repo@tag) into packagesDir and runs npm install --ignore-scripts when needed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-remote-test-'));
    try {
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');
      const hangarCfgPath = join(dir, 'hangar.json');
      const agyCfgPath = join(dir, 'config.json');

      const execCalls = [];
      const mockExec = (cmd, args) => {
        execCalls.push({ cmd, args });
        if (cmd === 'git' && args[0] === 'clone') {
          const dest = args[args.length - 1];
          mkdirSync(dest, { recursive: true });
          writeJsonNoBom(join(dest, 'sidecar.json'), {
            command: 'node',
            args: ['server.mjs'],
            display_name: 'Remote Sidecar',
          });
          writeJsonNoBom(join(dest, 'package.json'), {
            name: 'remote-sidecar',
            version: '2.1.0',
            dependencies: { 'some-pkg': '^1.0.0' },
          });
        }
      };

      const res = await installRemoteSidecar({
        gitRepo: 'example-org/antigravity-remote-sidecar@v2.1.0',
        scope: 'global',
        packagesDir,
        sidecarsDir,
        configPath: hangarCfgPath,
        agyConfigPath: agyCfgPath,
        rpcFn: async () => ({}),
        execFn: mockExec,
        delayMs: 0,
      });

      assert.equal(res.sidecarId, 'remote-sidecar');
      assert.equal(res.rule.source, 'github');
      assert.equal(res.rule.installedVersion, '2.1.0');
      assert.equal(res.rule.gitRepo, 'https://github.com/example-org/antigravity-remote-sidecar');
      assert.equal(execCalls.length, 2);
      assert.equal(execCalls[0].cmd, 'git');
      assert.deepEqual(execCalls[0].args.slice(0, 5), [
        'clone',
        '--depth',
        '1',
        '--branch',
        'v2.1.0',
      ]);
      assert.equal(execCalls[0].args[5], 'https://github.com/example-org/antigravity-remote-sidecar.git');
      assert.ok(execCalls[1].args.includes('--ignore-scripts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('self-updates Hangar into packages/hangar@<ver>, bundles antigravity-sidecar-kit, re-links sidecars/hangar, and triggers ManageSidecar RESTART', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-self-update-test-'));
    try {
      const sidecarsDir = join(dir, 'sidecars');
      const packagesDir = join(dir, 'packages');
      const agyCfgPath = join(dir, 'config.json');
      writeJsonNoBom(agyCfgPath, { sidecars: { hangar: { enabled: true } } });

      const rpcCalls = [];
      const mockExec = (cmd, args) => {
        if (cmd === 'git' && args[0] === 'clone') {
          const dest = args[args.length - 1];
          mkdirSync(dest, { recursive: true });
          writeJsonNoBom(join(dest, 'sidecar.json'), {
            command: 'node',
            args: ['server.mjs'],
            display_name: 'Hangar',
          });
          writeJsonNoBom(join(dest, 'package.json'), {
            name: 'antigravity-hangar',
            version: '9.0.0',
            dependencies: { 'antigravity-sidecar-kit': '^1.0.1' },
          });
        }
      };

      const res = await selfUpdateHangar({
        version: '9.0.0',
        packagesDir,
        sidecarsDir,
        agyConfigPath: agyCfgPath,
        rpcFn: async (method, payload) => {
          rpcCalls.push({ method, payload });
          return { ok: true };
        },
        execFn: mockExec,
        delayMs: 0,
      });

      assert.equal(res.ok, true);
      assert.equal(res.sidecarId, 'hangar');
      assert.equal(res.updatedVersion, '9.0.0');
      assert.equal(existsSync(join(sidecarsDir, 'hangar', 'sidecar.json')), true);
      assert.equal(
        existsSync(join(sidecarsDir, 'hangar', 'node_modules', 'antigravity-sidecar-kit', 'package.json')),
        true
      );
      assert.equal(rpcCalls.length, 1);
      assert.deepEqual(rpcCalls[0], {
        method: 'ManageSidecar',
        payload: { action: 'SIDECAR_ACTION_RESTART', sidecarId: 'hangar' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
