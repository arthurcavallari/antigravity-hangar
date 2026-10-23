import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRegistry } from '../scripts/validate-registry.mjs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

describe('registry.json validation', () => {
  it('accepts the shipped registry.json, whose hangar version matches package.json', () => {
    assert.deepEqual(validateRegistry(read('registry.json'), { packageVersion: read('package.json').version }), []);
  });

  it('rejects entries that would break or endanger installs', () => {
    const base = read('registry.json');
    const pkg = base.packages[0];
    const errorsFor = (overrides, opts = {}) =>
      validateRegistry({ ...base, packages: [{ ...pkg, ...overrides }] }, opts).join('\n');

    assert.match(errorsFor({ id: '../evil' }), /id must match/);
    assert.match(errorsFor({ id: 'hangar' }), /reserved/);
    assert.match(errorsFor({ capabilityTier: 'TIER_0' }), /capabilityTier must be one of/);
    assert.match(errorsFor({ latestVersion: 'latest' }), /latestVersion must be semver/);
    assert.match(errorsFor({ release: { gitRepo: 'http://github.com/a/b' } }), /gitRepo must be an https URL/);
    assert.match(errorsFor({ release: { tarballUrl: 'https://x.test/a.tgz' } }), /requires a 64-hex sha256/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['../../.ssh/id_rsa'] } }), /relative paths inside the workspace/);
    assert.match(errorsFor({ workspaceTriggers: { files: ['C:/Windows/win.ini'] } }), /relative paths inside the workspace/);
    assert.match(validateRegistry({ ...base, packages: [pkg, pkg] }).join('\n'), /duplicate/);
    assert.match(validateRegistry({ ...base, featuredIds: ['nope'] }).join('\n'), /unknown package "nope"/);
    assert.match(validateRegistry(base, { packageVersion: '9.9.9' }).join('\n'), /must match package\.json version/);
  });

  it('accepts plugin entries, including ports pinned to a ref, and reads a missing kind as a sidecar', () => {
    const base = read('registry.json');
    const pkg = base.packages[0];
    const port = {
      ...pkg,
      id: 'core-workflows',
      kind: 'plugin',
      port: { from: 'claude' },
      release: { gitRepo: 'https://github.com/acme/plugins', ref: 'a'.repeat(40), path: 'plugins/commit-commands' },
    };
    const native = { ...pkg, id: 'native-plugin', kind: 'plugin', release: { gitRepo: 'https://github.com/acme/native', ref: 'v1.2.0' } };
    assert.deepEqual(validateRegistry({ ...base, packages: [pkg, port, native] }), []);
    assert.deepEqual(validateRegistry({ ...base, packages: [{ ...pkg, kind: 'sidecar' }] }), []);
  });

  it('rejects plugin fields that would install the wrong code or an unpinned port', () => {
    const base = read('registry.json');
    const pkg = base.packages[0];
    const plugin = {
      ...pkg,
      kind: 'plugin',
      port: { from: 'claude' },
      release: { gitRepo: 'https://github.com/acme/plugins', ref: 'v1.0.0' },
    };
    const errorsFor = (overrides) => validateRegistry({ ...base, packages: [{ ...plugin, ...overrides }] }).join('\n');
    const releaseErrors = (release) => errorsFor({ release: { ...plugin.release, ...release } });

    assert.match(errorsFor({ kind: 'extension' }), /kind must be "sidecar" or "plugin"/);
    assert.match(errorsFor({ kind: undefined }), /port needs kind "plugin"/);
    assert.match(errorsFor({ port: { from: 'vscode' } }), /port\.from must be one of/);
    assert.match(errorsFor({ release: { gitRepo: plugin.release.gitRepo } }), /release\.ref is required when port is set/);
    assert.match(
      errorsFor({ release: { tarballUrl: 'https://x.test/a.tgz', sha256: 'a'.repeat(64), ref: 'v1.0.0' } }),
      /release\.gitRepo is required when port is set/
    );
    assert.match(releaseErrors({ ref: 'abc1234' }), /full 40-character commit SHA/);
    assert.match(releaseErrors({ ref: '--upload-pack=touch /tmp/pwned' }), /full 40-character commit SHA/);
    assert.match(releaseErrors({ ref: 'v1/../../x' }), /full 40-character commit SHA/);
    assert.match(releaseErrors({ path: '../outside' }), /relative path inside the package/);
    assert.match(releaseErrors({ path: 'C:/Windows' }), /relative path inside the package/);
  });

  it('accepts release.path and release.ref on sidecar entries, but not on Hangar itself', () => {
    const base = read('registry.json');
    const pkg = base.packages[0];
    const cockpit = { ...pkg, id: 'porter-cockpit', release: { ...pkg.release, ref: 'v0.1.0', path: 'cockpit' } };
    assert.deepEqual(validateRegistry({ ...base, packages: [pkg, cockpit] }), []);
    const sidecarErrors = (release) =>
      validateRegistry({ ...base, packages: [{ ...cockpit, release: { ...cockpit.release, ...release } }] }).join('\n');
    assert.match(sidecarErrors({ ref: 'abc1234' }), /full 40-character commit SHA/);
    assert.match(sidecarErrors({ path: '../outside' }), /relative path inside the package/);
    assert.match(
      validateRegistry({ ...base, hangar: { ...base.hangar, release: { ...base.hangar.release, path: 'sub' } } }).join('\n'),
      /hangar\.release\.path and release\.ref are not supported/
    );
  });
});
