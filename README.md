# Antigravity Hangar (`antigravity-hangar`)

> **Hangar** is a project-aware Chrome-style tab multiplexer, split-pane telemetry host, local package linker, and extension marketplace for Google Antigravity Auxiliary Pane sidecars.

---

## 1. The Problem Hangar Solves

1. **No Project Awareness**: Antigravity loads every enabled sidecar globally across all workspaces. A database or container sidecar clutters the UI and burns RAM when working on an unrelated frontend repo, and vice versa.
2. **Single-Panel Limitation**: Antigravity's Auxiliary Pane can only display one sidecar iframe at a time—forcing you to choose between live context/quota telemetry and project-specific tools.
3. **High Installation Friction**: Installing or linking a sidecar manually requires cloning a repo, creating OS-specific symlinks/junctions in `~/.gemini/config/sidecars/`, editing `~/.gemini/config/config.json`, and invoking internal Language Server RPCs.

---

## 2. Quick Start

```bash
git clone https://github.com/arthurcavallari/antigravity-hangar.git
cd antigravity-hangar
npm run setup
```

Then select **Hangar** from the Antigravity Auxiliary Pane dropdown.

---

## 3. Core Capabilities

1. **Chrome-Style Project-Aware Tab Multiplexer & Split-Pane Host**:
   - Hosts multiple child sidecars inside a single Auxiliary Pane with `0ms` tab switching (`display: block/none` persistent iframes) and pointer-captured drag-and-drop tab reordering.
   - **Split-Pane View**: Pin global telemetry (such as [`antigravity-context-monitor`](https://github.com/arthurcavallari/antigravity-context-monitor)) in the top pane while switching between project-specific sidecars in the bottom pane.
   - Automatically detects the active workspace (`window.sidecar.onWorkspaceChange` + `GetAllCascadeTrajectories` `lastUserViewTime` resolution) and displays only the tabs mapped to that project (or pinned globally with `*`).
   - Optionally auto-hibernates (`SIDECAR_ACTION_DISABLE`) background Node.js processes after a configurable idle TTL (`hibernateAfterIdleMinutes`) when a project is inactive.
2. **Built-In Extension Manager & 1-Click Store (`🧩 Extensions` Tab)**:
   - **Installed**: Enable/disable processes, configure workspace path/glob rules, restart, update, or uninstall sidecars.
   - **Discover**: Browse the online registry with capability tier badges (`Tier 1 Telemetry`, `Tier 2 Local CLI`, `Tier 3 Agent Control`) and 1-click installation.
   - **Sideload**: Link any local development directory (`source: "local"`) via NTFS junction / symlink or install directly from a GitHub repository URL.

---

## 4. Repository Layout

```text
antigravity-hangar/
├── server.mjs                      # Thin routing entrypoint (<= 80 lines)
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
│       ├── tab-bar.js              # Chrome tab strips & 150ms sibling slide physics
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
