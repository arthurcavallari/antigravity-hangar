/**
 * @fileoverview Downloads remote packages (a tarball or a git checkout) and swaps prepared folders into
 * place. Shared by the sidecar installer and the plugin installer.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeLinkOrDir } from 'antigravity-sidecar-kit/setup';

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function parseGitRepoSpec(rawRepo = '') {
  let raw = String(rawRepo || '').trim();
  let gitRef = '';
  if (!raw.startsWith('git@')) {
    const atIdx = raw.lastIndexOf('@');
    if (atIdx > 0 && !raw.slice(atIdx).includes('/')) {
      gitRef = raw.slice(atIdx + 1).trim();
      raw = raw.slice(0, atIdx).trim();
    }
  }
  if (raw && !/^https?:\/\/|^git@/i.test(raw) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw)) {
    raw = `https://github.com/${raw}.git`;
  }
  return { repoUrl: raw, gitRef };
}

// A leading "-" would be parsed by git as an option rather than a repository or branch
export function assertSafeGitSpec(cleanRepo = '', gitRef = '') {
  if (cleanRepo.startsWith('-') || gitRef.startsWith('-')) {
    throw new Error(`Invalid repository spec: ${cleanRepo}${gitRef ? `@${gitRef}` : ''}`);
  }
}

// Fills destDir (an existing, empty folder) with the package: the tarball when there is one, checked
// against sha256, otherwise a shallow git checkout of gitRef. `git clone --branch` only takes branch
// and tag names, so a full commit SHA is fetched on its own.
export async function downloadRemoteSource({
  id, cleanRepo = '', gitRef = '', tarballUrl = '', sha256 = '', destDir, packagesDir,
  fetchFn = globalThis.fetch, execFn = execFileSync,
}) {
  assertSafeGitSpec(cleanRepo, gitRef);
  if (tarballUrl) {
    try {
      const res = await fetchFn(tarballUrl, { signal: AbortSignal.timeout(15000) });
      if (!res?.ok) throw new Error(`Failed to download tarball (${res?.status || 'network error'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256) {
        const digest = createHash('sha256').update(buf).digest('hex');
        if (digest.toLowerCase() !== String(sha256).toLowerCase()) {
          throw new Error(`SHA-256 mismatch: expected ${sha256}, got ${digest}`);
        }
      }
      const tgzPath = join(packagesDir, `${id}-${Date.now()}.tgz`);
      writeFileSync(tgzPath, buf);
      try {
        execFn('tar', ['-xzf', tgzPath, '-C', destDir, '--strip-components=1'], { stdio: 'pipe' });
        return;
      } finally {
        removeLinkOrDir(tgzPath);
      }
    } catch (err) {
      if (!cleanRepo || sha256 || String(err?.message || '').startsWith('SHA-256 mismatch')) {
        throw err;
      }
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir);
    }
  }
  if (FULL_SHA.test(gitRef)) {
    execFn('git', ['init', '-q', destDir], { stdio: 'pipe' });
    execFn('git', ['-C', destDir, 'fetch', '-q', '--depth', '1', '--', cleanRepo, gitRef], { stdio: 'pipe' });
    execFn('git', ['-C', destDir, 'checkout', '-q', 'FETCH_HEAD'], { stdio: 'pipe' });
    return;
  }
  const cloneArgs = ['clone', '--depth', '1'];
  if (gitRef) cloneArgs.push('--branch', gitRef);
  cloneArgs.push('--', cleanRepo, destDir);
  execFn('git', cloneArgs, { stdio: 'pipe' });
}

// Moves a fully prepared staging folder onto targetDir, restoring the previous copy if the swap fails.
export function swapIntoPlace(stagingDir, targetDir) {
  if (!pathExists(targetDir)) {
    renameSync(stagingDir, targetDir);
    return;
  }
  const previousDir = `${stagingDir}.previous`;
  renameSync(targetDir, previousDir);
  try {
    renameSync(stagingDir, targetDir);
  } catch (err) {
    renameSync(previousDir, targetDir);
    throw err;
  }
  try {
    rmSync(previousDir, { recursive: true, force: true });
  } catch {
    // Leftover <id>@... folders are swept by uninstallSidecar and uninstallPlugin
  }
}
