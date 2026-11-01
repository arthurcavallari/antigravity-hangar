/**
 * @fileoverview Self-healing launcher for Antigravity Hangar.
 * Binds ANTIGRAVITY_SIDECAR_WEB_PORT with a diagnostic Retry page if dependencies
 * are missing or server.mjs crashes on startup.
 */

import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

try {
  const { runSidecarLauncher } = await import('antigravity-sidecar-kit/launcher');
  const code = await runSidecarLauncher({
    sidecarName: 'Antigravity Hangar',
    targetPath: join(__dirname, 'server.mjs'),
    repoRoot: __dirname,
    requiredPaths: [
      join(__dirname, 'node_modules', 'antigravity-sidecar-kit', 'package.json'),
      join(__dirname, 'ui', 'index.html'),
    ],
    remediationCommand: 'npm install && npm run setup',
    registerSignalHandlers: true,
  });
  process.exit(code ?? 0);
} catch (err) {
  const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
  if (!port || existsSync(join(__dirname, 'node_modules', 'antigravity-sidecar-kit', 'lib', 'launcher.mjs'))) {
    console.error('[hangar] Launcher failed:', err?.message || err);
    process.exit(1);
  }
  const srv = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/__launcher/retry')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      srv.close(() => process.exit(1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body style="font-family:system-ui;padding:24px"><h1>Antigravity Hangar dependencies missing</h1>` +
        `<p>Run <code>npm install &amp;&amp; npm run setup</code> in <code>${__dirname}</code>, then click Retry.</p>` +
        `<button onclick="fetch('/__launcher/retry',{method:'POST'}).then(()=>setTimeout(()=>location.reload(),800))">Retry</button></body></html>`
    );
  });
  srv.listen(port, '127.0.0.1');
}
