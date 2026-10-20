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
- **Node.js** `>= 20.0.0` (zero external npm dependencies; uses built-in `sidecar_sdk` injected by Antigravity)

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
4. Runs the automated unit test suite (`npm test`).
5. Links `~/.gemini/config/sidecars/hangar` to your package checkout (using an NTFS directory junction on Windows or directory symlink on macOS/Linux, copying out of ephemeral `_npx` caches into `~/.gemini/hangar/packages/` automatically).
6. Enables `sidecars["hangar"]` in `~/.gemini/config/config.json` (writing UTF-8 without BOM).
7. Hot-reloads the sidecar via the Language Server `ManageSidecar` RPC when invoked inside an active Antigravity session.

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
   - **Installed**: Enable/disable processes, configure workspace path/glob rules, restart, update, or uninstall sidecars.
   - **Discover**: Browse the online registry with capability tier badges (`Tier 1 Telemetry`, `Tier 2 Local CLI`, `Tier 3 Agent Control`), workspace file trigger suggestions, and 1-click installation.
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
│   ├── rpc-client.mjs              # Language Server Connect RPC client
│   ├── theme.mjs                   # Host theme seed resolver & stylesheet proxy
│   ├── config-store.mjs            # BOM-safe hangar.json store, rules & child URLs
│   ├── workspace-resolver.mjs      # Active workspace & trajectory resolver + glob matcher
│   ├── hibernation-manager.mjs     # Debounced idle-TTL process hibernation manager
│   ├── package-installer.mjs       # Local junction linker, GitHub/tarball installer & inspector
│   ├── registry-catalog.mjs        # Marketplace registry fetcher & workspace trigger advisor
│   └── state-orchestrator.mjs      # GetSidecars + trajectory state coordinator
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
│       └── marketplace-panes.js    # Discover catalog & Sideload (Local / GitHub) panes
└── test/
    ├── config-store.test.mjs
    ├── theme.test.mjs
    ├── workspace-resolver.test.mjs
    ├── hibernation-manager.test.mjs
    ├── package-installer.test.mjs
    └── registry-catalog.test.mjs
```

---

## 7. Privacy & Anonymous Telemetry Opt-Out

When fetching the online Marketplace catalog (`GET <registryUrl>/registry.json`), Hangar includes anonymous, non-PII headers (`X-Hangar-Install-Id`, `X-Hangar-Version`, `X-Hangar-OS`, `X-Hangar-Sidecars`) to measure active installs and OS/version compatibility. No workspace paths, repository names, or sidecar identifiers are ever sent.

To opt out of telemetry headers completely, set any of the following:
- `"telemetry": false` in `~/.gemini/config/hangar.json`
- `DO_NOT_TRACK=1` or `HANGAR_TELEMETRY=0` in your environment

---

## License

[MIT](./LICENSE)
