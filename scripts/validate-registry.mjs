#!/usr/bin/env node
/**
 * @fileoverview Validates registry.json. The registry Worker serves it straight from main, so a broken
 * or unsafe entry reaches every Hangar install within minutes; CI runs this on every push and PR.
 *
 * Usage: node scripts/validate-registry.mjs [path/to/registry.json]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;
// Same shape sanitizeSidecarId() produces, so a registry id always installs under its own name
const SIDECAR_ID = /^[a-z0-9][a-z0-9_-]*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const TIERS = new Set(['TIER_1_TELEMETRY', 'TIER_2_LOCAL_TOOLING', 'TIER_3_AGENT_CONTROL']);
const RESERVED_IDS = new Set(['hangar', 'sidecar-hub']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function checkRelease(release, where, errors) {
  if (!isObject(release)) {
    errors.push(`${where}.release must be an object`);
    return;
  }
  const { gitRepo, tarballUrl, sha256 } = release;
  if (!gitRepo && !tarballUrl) errors.push(`${where}.release needs gitRepo or tarballUrl`);
  if (gitRepo !== undefined && !isHttpsUrl(gitRepo)) errors.push(`${where}.release.gitRepo must be an https URL`);
  if (tarballUrl !== undefined) {
    if (!isHttpsUrl(tarballUrl)) errors.push(`${where}.release.tarballUrl must be an https URL`);
    // Without a hash, a registry tarball is installed unverified
    if (!SHA256.test(String(sha256 || ''))) errors.push(`${where}.release.tarballUrl requires a 64-hex sha256`);
  }
}

/** Returns a list of human-readable problems; empty means the registry is valid. */
export function validateRegistry(registry, { packageVersion } = {}) {
  const errors = [];
  if (!isObject(registry)) return ['registry must be a JSON object'];

  const { hangar, packages, featuredIds } = registry;
  if (!isObject(hangar)) {
    errors.push('hangar must be an object');
  } else {
    if (hangar.id !== 'hangar') errors.push('hangar.id must be "hangar"');
    if (!SEMVER.test(String(hangar.latestVersion || ''))) errors.push('hangar.latestVersion must be semver');
    if (packageVersion && hangar.latestVersion !== packageVersion) {
      errors.push(`hangar.latestVersion (${hangar.latestVersion}) must match package.json version (${packageVersion})`);
    }
    if (hangar.npmPackage !== undefined && !NPM_NAME.test(hangar.npmPackage)) errors.push('hangar.npmPackage is not a valid npm name');
    checkRelease(hangar.release, 'hangar', errors);
  }

  if (!Array.isArray(packages)) return [...errors, 'packages must be an array'];
  const seen = new Set();
  packages.forEach((pkg, i) => {
    const where = `packages[${i}]${isObject(pkg) && pkg.id ? ` (${pkg.id})` : ''}`;
    if (!isObject(pkg)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!SIDECAR_ID.test(String(pkg.id || ''))) errors.push(`${where}.id must match ${SIDECAR_ID}`);
    if (RESERVED_IDS.has(pkg.id)) errors.push(`${where}.id is reserved`);
    if (seen.has(pkg.id)) errors.push(`${where}.id is a duplicate`);
    seen.add(pkg.id);
    if (!isNonEmptyString(pkg.name)) errors.push(`${where}.name is required`);
    if (!SEMVER.test(String(pkg.latestVersion || ''))) errors.push(`${where}.latestVersion must be semver`);
    if (!TIERS.has(pkg.capabilityTier)) errors.push(`${where}.capabilityTier must be one of ${[...TIERS].join(', ')}`);
    if (pkg.npmPackage !== undefined && !NPM_NAME.test(pkg.npmPackage)) errors.push(`${where}.npmPackage is not a valid npm name`);
    if (pkg.categories !== undefined && !(Array.isArray(pkg.categories) && pkg.categories.every(isNonEmptyString))) {
      errors.push(`${where}.categories must be an array of strings`);
    }
    const files = pkg.workspaceTriggers?.files;
    if (files !== undefined) {
      // Trigger files are joined onto the user's workspace path, so they must stay relative and inside it
      const bad = Array.isArray(files)
        ? files.filter((f) => !isNonEmptyString(f) || /^[\\/]|^[a-z]:/i.test(f) || f.split(/[\\/]/).includes('..'))
        : [files];
      if (bad.length) errors.push(`${where}.workspaceTriggers.files must be relative paths inside the workspace: ${JSON.stringify(bad)}`);
    }
    checkRelease(pkg.release, where, errors);
  });

  if (featuredIds !== undefined) {
    if (!Array.isArray(featuredIds)) errors.push('featuredIds must be an array');
    else for (const id of featuredIds.filter((f) => !seen.has(f))) errors.push(`featuredIds references unknown package "${id}"`);
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const registryPath = resolve(process.argv[2] || join(REPO_ROOT, 'registry.json'));
  const { version } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    console.error(`${registryPath}: ${err.message}`);
    process.exit(1);
  }
  const errors = validateRegistry(registry, { packageVersion: version });
  for (const e of errors) console.error(`registry.json: ${e}`);
  if (errors.length) process.exit(1);
  console.log(`registry.json is valid (${registry.packages.length} packages)`);
}
