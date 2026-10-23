# Antigravity Hangar (`antigravity-hangar`)

> **Hangar** is a project-aware Chrome-style tab multiplexer, split-pane telemetry host, local package linker, and extension marketplace for **Google Antigravity** Auxiliary Pane sidecars.

Mounts natively in Antigravity's Auxiliary (right-hand) Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) and syncs automatically with your active workspace and editor theme (dark, light, high-contrast, and custom theme seeds).

---

## 1. The Problem Hangar Solves

1. **No Project Awareness**: Antigravity loads every enabled sidecar globally across all workspaces. A database or container sidecar clutters the UI and burns RAM when working on an unrelated frontend repo, and vice versa.
2. **Single-Panel Limitation**: Antigravity's Auxiliary Pane can only display one sidecar iframe at a time—forcing you to choose between live context/quota telemetry and project-specific tools.
3. **High Installation Friction**: Installing or linking a sidecar manually requires cloning a repo, creating OS-specific symlinks/junctions in `~/.gemini/config/sidecars/`, editing `~/.gemini/config/config.json`, and invoking internal Language Server RPCs.

---

## 2. Requirements

- **Google Antigravity** (2.0 Desktop / IDE with `SidecarManager` support)
- **Node.js** `>= 20.0.0` (zero third-party npm dependencies; powered by [`antigravity-sidecar-kit`](https://github.com/arthurcavallari/antigravity-sidecar-kit) and Antigravity's built-in `sidecar_sdk`)

---

## 3. Installation

```bash
# Option A: 1-command install via npx
npx antigravity-hangar

# Option B: Clone and link locally
git clone https://github.com/arthurcavallari/antigravity-hangar.git
cd antigravity-hangar
npm run setup
```

Then select **Hangar** from the Antigravity Auxiliary Pane dropdown.

What `setup` does:
1. Validates all required sidecar manifest, backend, and UI assets.
2. Migrates any legacy `sidecar-hub` configuration or junctions automatically.
3. Initializes `~/.gemini/config/hangar.json` with default split-pane and workspace rules if not present.
4. Links `~/.gemini/config/sidecars/hangar` to your package checkout (using an NTFS directory junction on Windows or directory symlink on macOS/Linux, copying out of ephemeral `_npx` caches into `~/.gemini/hangar/packages/` automatically).
5. Enables `sidecars["hangar"]` in `~/.gemini/config/config.json` (writing UTF-8 without BOM).
6. Hot-reloads the sidecar via the Language Server `ManageSidecar` RPC when invoked inside an active Antigravity session.

### Uninstallation

```bash
npm run uninstall
```

Removes the `~/.gemini/config/sidecars/hangar` link, sets `sidecars["hangar"].enabled = false` in `~/.gemini/config/config.json`, and disables the sidecar via RPC.

---

## 4. Core Capabilities

1. **Chrome-Style Project-Aware Tab Multiplexer & Split-Pane Host**:
   - Hosts multiple child sidecars inside a single Auxiliary Pane with `0ms` tab switching (`display: block/none` persistent iframes) and pointer-captured drag-and-drop tab reordering.
   - **Native Tab Overflow & Navigation**: Handles narrow Auxiliary Panes with `38px` dynamic edge-fade masks, horizontal mouse-wheel scrolling, drag-to-edge auto-scrolling, and a `⋯` overflow popover for instant switching across all open tabs.
   - **Split-Pane View**: Pin global telemetry (such as [`antigravity-context-monitor`](https://github.com/arthurcavallari/antigravity-context-monitor)) in the top pane while switching between project-specific sidecars in the bottom pane, separated by a draggable resize sash.
   - **Automatic Workspace Resolution**: Detects the active workspace (`window.sidecar.onWorkspaceChange` + `GetAllCascadeTrajectories` `lastUserViewTime` resolution) and displays only the tabs mapped to that project (or pinned globally with `*`).
   - **Idle Process Hibernation**: Automatically hibernates (`SIDECAR_ACTION_DISABLE`) background Node.js processes after a configurable idle TTL (`hibernateAfterIdleMinutes`) when a project is inactive.
2. **Built-In Extension Manager & 1-Click Store (`🧩 Extensions` Tab)**:
   - **Installed**: Enable/disable processes, configure workspace path/glob rules, restart, update, or uninstall sidecars. A **Plugins** section lists Antigravity plugins (skills, agents, rules, hooks, MCP servers) and updates or uninstalls the ones Hangar installed.
   - **Discover**: Browse the online registry with capability tier badges (`Tier 1 Telemetry`, `Tier 2 Local CLI`, `Tier 3 Agent Control`), workspace file trigger suggestions, and 1-click installation. Plugins ported from Claude Code, Gemini CLI, Cursor, Roo/Kilo or Codex are ported on your machine by [`agy-plugin-porter`](https://github.com/arthurcavallari/agy-plugin-porter), and the port report (what will and won't port, plus audit findings) is shown before you confirm. Restart Antigravity to load a new plugin.
   - **Sideload**: Link any local development directory (`source: "local"`) via NTFS junction / symlink or install directly from a GitHub repository URL (`owner/repo` or `https://github.com/...`).

---

## 5. Authoring Sidecars for Hangar (`hub-manifest.json`)

Any Antigravity sidecar repository (`sidecar.json`) works with Hangar out of the box. To provide rich metadata, capability tier badges, and automatic workspace trigger suggestions in Hangar's Marketplace and Sideload inspector, add an optional `hub-manifest.json` to your sidecar's root directory:

```json
{
  "id": "my-sidecar",
  "name": "My Sidecar",
  "tagline": "Short description shown in Hangar's Discover and Installed cards.",
  "version": "1.0.0",
  "author": {
    "name": "Your Name",
    "github": "your-github-handle"
  },
  "license": "MIT",
  "pricing": "free",
  "categories": ["productivity"],
  "capabilityTier": "TIER_1_TELEMETRY",
  "workspaceTriggers": {
    "files": ["docker-compose.yml", "Dockerfile"]
  },
  "minAntigravityVersion": "2.0.0"
}
```

### Listing a plugin in the registry

A `registry.json` entry without `kind` is a sidecar. A plugin entry sets `"kind": "plugin"`. A plugin from another tool also sets `port.from` (`claude`, `gemini`, `cursor`, `roo`, `codex` or `auto`) and pins the upstream repository with `release.ref`, a tag or a full commit SHA. Hangar never redistributes the upstream code: it clones the pinned commit, ports and audits it locally, then installs it with `agy plugin install`. `release.path` picks a subfolder, for monorepos.

```json
{
  "id": "core-workflows",
  "kind": "plugin",
  "name": "Core Workflows",
  "latestVersion": "1.0.0",
  "capabilityTier": "TIER_2_LOCAL_TOOLING",
  "port": { "from": "claude" },
  "release": {
    "gitRepo": "https://github.com/owner/repo",
    "ref": "0123456789abcdef0123456789abcdef01234567",
    "path": "plugins/core-workflows"
  }
}
```

A sidecar entry can set `release.ref` and `release.path` too. Hangar checks out the pinned ref, runs `npm install` in the subfolder, and links `sidecars/<id>` to it; the capability scan still covers the whole download. Hangar doesn't check upstream for newer versions of a pinned entry, so bump `latestVersion` whenever you change `ref`.

---

## 6. Development & Testing

Run the automated test suite:

```bash
npm test
```

### Repository Layout

```text
antigravity-hangar/
├── package.json
├── server.mjs                      # Thin SidecarApp routing entrypoint
├── setup.mjs                       # Cross-machine junction linker & LS RPC installer
├── sidecar.json                    # Antigravity sidecar manifest
├── registry.json                   # Public marketplace package catalog
├── lib/
│   ├── constants.mjs               # Paths, REPO_ROOT (realpathSync), default config
│   ├── config-store.mjs            # BOM-safe hangar.json store, rules & child URLs
│   ├── hibernation-manager.mjs     # Debounced idle-TTL process hibernation manager
│   ├── ls-rpc.mjs                  # Shared, briefly cached Language Server state reads
│   ├── package-installer.mjs       # Local junction linker, GitHub/tarball installer & inspector
│   ├── plugin-installer.mjs        # Plugin port, audit, install, list & uninstall
│   ├── registry-catalog.mjs        # Marketplace registry fetcher & workspace trigger advisor
│   ├── remote-source.mjs           # Tarball / git download & atomic folder swap
│   └── state-orchestrator.mjs      # GetSidecars + GetAllPlugins + trajectory state coordinator
├── ui/
│   ├── index.html                  # Semantic markup shell
│   ├── styles.css                  # Theme variables, chrome bar, tabs, popover & split sash
│   ├── components.css              # Extension cards, switches, badges & rule inputs
│   ├── core.js                     # Authenticated fetch wrapper, Material SVG icons & formatters
│   ├── app.js                      # Main UI state & event wiring
│   └── components/
│       ├── tab-bar.js              # Chrome tab strips, edge-fade overflow & 150ms drag physics
│       ├── iframe-deck.js          # Persistent child iframe deck & postMessage relay bridge
│       ├── project-popover.js      # [+] Quick workspace rule popover
│       ├── extensions-tab.js       # Extensions shell & Installed sidecars manager
│       ├── marketplace-panes.js    # Discover catalog & Sideload (Local / GitHub) panes
│       └── plugin-panes.js         # Plugin badges, port report consent & Installed plugins
└── test/
    ├── config-store.test.mjs
    ├── hibernation-manager.test.mjs
    ├── package-installer.test.mjs
    └── registry-catalog.test.mjs
```

---

## 7. Privacy & Anonymous Telemetry Opt-Out

When fetching the online Marketplace catalog from `https://hangar.arthurcavallari.dev/registry.json`, Hangar includes anonymous, non-PII headers (`X-Hangar-Install-Id`, a random ID generated on your machine, plus `X-Hangar-Version`, `X-Hangar-OS`, and `X-Hangar-Sidecars`, the number of configured sidecars) to measure active installs and OS/version compatibility. No workspace paths, repository names, or sidecar identifiers are sent in telemetry.

To opt out completely, set any of the following. Hangar then sends no telemetry headers, and nothing about your install is recorded:
- `"telemetry": false` in `~/.gemini/config/hangar.json`
- `DO_NOT_TRACK=1` or `HANGAR_TELEMETRY=0` in your environment

Separately, update checks look up Hangar and the sidecars it installed on npm and GitHub by package name, like any update check. These aren't affected by the opt-out.

---

## License

[MIT](./LICENSE)
