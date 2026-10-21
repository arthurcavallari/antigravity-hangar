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
});
