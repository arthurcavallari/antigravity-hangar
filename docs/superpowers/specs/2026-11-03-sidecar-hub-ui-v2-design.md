# `antigravity-sidecar-hub` (Hangar) UI v2 Design: Migration to `AgyUI.html`, `<agy-tab-strip>`, Unified Tab Drag, and `< 300`-Line Component Decomposition

## 1. Intent & Why

Although `antigravity-sidecar-hub` (`commits 4d8cdf0..704b52d`) wired `/shell.css`, `/shell.js`, and `registerUiRoutes(app, { modules: 'all' })` into [`server.mjs`](../../../server.mjs), the frontend codebase remains in a half-migrated state with major structural defects:

1. **Severe Violations of the 300-Line Ceiling Across 8 Frontend UI Files:**
   - [`ui/components/terminal-quote.js`](../../../ui/components/terminal-quote.js): **1,564 lines** (combines selection quote popup, mini-composer, full side-chat view, side-chat tab strip, pill pointer drag, and drop-zone inspection in one file).
   - [`ui/components/extensions-tab.js`](../../../ui/components/extensions-tab.js): **785 lines** (combines Installed tab, Discover tab, Link Local tab, workspace rule editor, and store state orchestration).
   - [`ui/app.js`](../../../ui/app.js): **665 lines** (combines per-workspace layout persistence, tab drop/merge orchestration, context-menu action handlers, side-chat dock callbacks, and state polling).
   - [`ui/components/terminal-tab.js`](../../../ui/components/terminal-tab.js): **465 lines**.
   - [`ui/components/marketplace-panes.js`](../../../ui/components/marketplace-panes.js): **450 lines**.
   - [`ui/components/tab-bar.js`](../../../ui/components/tab-bar.js): **437 lines** (despite cramming 4–6 statements onto single lines in `lines 169-352`).
   - [`ui/components/terminal-groups.js`](../../../ui/components/terminal-groups.js): **385 lines**.
   - [`ui/components/iframe-deck.js`](../../../ui/components/iframe-deck.js): **334 lines**.
2. **Three Duplicate Pointer-Drag Controllers & Shadowed `setupStripScroll`:**
   - [`tab-bar.js:191-288`](../../../ui/components/tab-bar.js#L191-L288), [`terminal-groups.js:245-354`](../../../ui/components/terminal-groups.js#L245-L354), and [`terminal-quote.js:674-800`](../../../ui/components/terminal-quote.js#L674-L800) each implement their own 100+ line pointer-drag loop instead of using `AgyUI.bindTabDragController`.
   - [`tab-bar.js:290-353`](../../../ui/components/tab-bar.js#L290-L353) defines a local `function setupStripScroll` that shadows `ns.setupStripScroll` / `AgyUI.setupStripScroll`.
   - [`tab-bar.js:406-423`](../../../ui/components/tab-bar.js#L406-L423) only calls `AgyUI.reconcileTabStrip` when `tabs.length === 0`, running a custom DOM reconciliation loop for non-empty strips.
3. **Concrete Auth Bug in Inline Rename (`tab-bar.js:146`):**
   - Double-clicking a popped `terminal__*` tab in `tab-bar.js` calls raw `fetch('/api/terminal/rename', ...)` instead of `ns.apiCall('/api/terminal/rename', ...)`, omitting `X-Sidecar-Token` and failing with `401/403` when `ANTIGRAVITY_SIDECAR_UI_TOKEN` is set.
4. **Duplicated Icon Registry, Fallbacks, and Nested `el()` Pyramids:**
   - [`ui/core.js:9-240`](../../../ui/core.js#L9-L240) duplicates all 20 SVG icon paths (`PATHS`) and keeps full fallback implementations for `iconSvg`, `iconEl`, `el`, `clear`, `formatStatusBadge`, and `openTabContextMenu`.
   - `marketplace-panes.js`, `plugin-panes.js`, and `extensions-tab.js` construct cards via deeply nested `el('div', { className: ... }, [ el('div', ...) ])` calls.

This design migrates Hangar to `antigravity-sidecar-kit` v2 (`AgyUI.html` tagged JSX, `<agy-tab-strip>`, `<agy-toggle-group>`, `<agy-split-sash>`, `<agy-switch>`, and `AgyUI.bindTabDragController`), fixes the unauthenticated `fetch` bug, deletes all duplicated fallback code, and decomposes the oversized component files so every file in the repository is `<= 300 lines`.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Hard 300-Line Ceiling Across Every UI & Entrypoint File (Builder Call):** Split `terminal-quote.js` (1,564 lines), `extensions-tab.js` (785 lines), `ui/app.js` (665 lines), `terminal-tab.js` (465 lines), `marketplace-panes.js` (450 lines), `tab-bar.js` (437 lines), `terminal-groups.js` (385 lines), and `iframe-deck.js` (334 lines) into focused `< 280`-line modules with readable formatting (no multi-statement single-line cramming). Backend `lib/*` modules remain untouched per Non-Goals.
- **Adopt `AgyUI.html` (`html\`...\``) for Declarative Views:** Replace `el('div', ...)` pyramids in `marketplace-panes.js`, `plugin-panes.js`, `extensions-tab.js`, `iframe-deck.js`, and `terminal-quote.js` with `html\`...\`` templates and `<agy-switch>` / `<agy-toggle-group>`.
- **Unify All Three Tab Strips on `AgyUI` (`<agy-tab-strip>` / `reconcileTabStrip`, `setupStripScroll`, `bindTabDragController`):**
  - Chrome Bar (`#tab-strip`, `#bottom-tab-strip` in `tab-bar.js`)
  - Terminal session strip (`[data-role="sessions"]` in `terminal-tab.js` & `terminal-groups.js`)
  - Side-Chat conversation strip (in `sidechat-pane.js`)
  All three use `AgyUI`'s tab strip reconciliation, overflow scroll controller, and `bindTabDragController` (passing strip-specific `onOutOfRailMove` and `onDrop` hooks for split-pane/terminal-merge targets).
- **Fix Authenticated API Calls:** Replace raw `fetch('/api/terminal/rename', ...)` in `tab-bar.js:146` with `ns.apiCall('/api/terminal/rename', ...)`.
- **Purge Duplicate Fallbacks in `ui/core.js` and `ui/styles.css`:** Remove the duplicate `PATHS` icon map and fallback implementations in `ui/core.js`, and remove duplicate `.agy-split-sash` / `body.resizing-split` rules in `ui/styles.css:52-61`.

### Non-Goals
- Changing Hangar's backend API routes, package/plugin installer semantics, or terminal PTY manager (`lib/*`).

### Anti-Goals
- Leaving `if (window.AgyUI?.reconcileTabStrip) { ... } else { /* 35 lines of legacy DOM creation */ }` blocks in `terminal-tab.js` or `terminal-quote.js`.
- Gaming line limits by cramming multiple statements onto 180-character lines.

---

## 3. Approaches Considered

### Approach 1 (Selected): Modular Component Decomposition (`<= 280 lines` per file) + `AgyUI.html` + Unified `bindTabDragController`
- **How it works:**
  - Decompose `terminal-quote.js` (1,564 lines) by responsibility into 4 focused files (`<= 280 lines` each):
    1. `ui/components/terminal-quote.js`: Selection quote popup & floating mini-composer (`<= 260 lines`).
    2. `ui/components/sidechat-store.js`: Side-chat cascade state, localStorage title/group persistence, and Language Server RPC helpers (`<= 240 lines`).
    3. `ui/components/sidechat-strip.js`: Side-chat tab strip reconciliation, inline rename, and `AgyUI.bindTabDragController` wiring (`<= 240 lines`).
    4. `ui/components/sidechat-pane.js`: Docked side-chat composer & iframe view (`<= 260 lines`).
  - Decompose `extensions-tab.js` (785 lines) + `marketplace-panes.js` (450 lines) by view:
    1. `ui/components/extensions-tab.js`: Store header, `<agy-toggle-group>` sub-navigation, search/filter bar, and state orchestration (`<= 260 lines`).
    2. `ui/components/installed-pane.js`: Installed sidecars & workspace rules card list using `AgyUI.html` and `<agy-switch>` (`<= 250 lines`).
    3. `ui/components/marketplace-panes.js`: Discover & Link Local panes using `AgyUI.html` (`<= 260 lines`).
    4. `ui/components/plugin-panes.js`: Plugins catalog & port-report consent cards using `AgyUI.html` (`<= 220 lines`).
  - Refactor `tab-bar.js` (437 lines $\rightarrow$ `<= 250 lines`), `terminal-tab.js` (465 lines $\rightarrow$ `<= 260 lines`), `terminal-groups.js` (385 lines $\rightarrow$ `<= 240 lines`), and `iframe-deck.js` (334 lines $\rightarrow$ `<= 240 lines`) by deleting their duplicate pointer-drag loops, duplicate `setupStripScroll`, and `else` fallback blocks in favor of `AgyUI`.
- **Tradeoffs:** Every file in `ui/` becomes small, single-purpose, and well under 300 lines without changing any user-facing behavior.

### Approach 2: Keep Monolithic `terminal-quote.js` and Only Swap `el()` for `html\`...\``
- **Why Rejected:** Even with `html\`...\``, `terminal-quote.js` would remain > 1,000 lines because it bundles four distinct subsystems (selection quote popup, mini-composer, side-chat state store, and docked side-chat pane) into one file.

---

## 4. Detailed Architecture & File Plan

### 4.1 Target File Inventory (`<= 300 Lines` Each)

| File | Current Lines | Target Lines | Key Responsibilities |
| :--- | :---: | :---: | :--- |
| `server.mjs` | 80 | `<= 80` | Register static UI routes (including split component scripts) and API routes without cramming multiple statements per line (move route table array to `lib/constants.mjs` if needed). |
| `ui/index.html` | 119 | `<= 125` | Load `/shell.css`, `/ui.css`, `/shell.js`, `/ui.js`, and component scripts in deterministic `defer` order. |
| `ui/styles.css` | 96 | `<= 80` | Remove duplicate `.agy-split-sash` / `body.resizing-split` / `body.dragging-tab` rules (served by `/ui.css` `layout` and `tab-drag` modules). |
| `ui/components.css` | 133 | `<= 130` | Keep Hangar-specific store, terminal stage, and mini-composer styles mapped to `--agy-*` tokens. |
| `ui/core.js` | 241 | `<= 95` | Alias `window.Hangar` helpers directly to `window.AgyUI` (`html`, `el`, `clear`, `iconSvg`, `iconEl`, `escHtml`, `apiCall`, `formatStatusBadge`, `openContextMenu`, `closeContextMenu`, `setupStripScroll`) and `window.AgyShell`; keep only Hangar-specific `formatCapabilityTier` and `isHostMessage`. |
| `ui/components/layout-controller.js` | *(split from `ui/app.js`)* | `<= 260` | Per-workspace layout persistence (`saveLayoutUpdate`, `applyWorkspaceLayout`), tab drop/merge orchestration (`handleDropTab`, `applyTerminalMergeLayout`), context-menu actions (`handleTabContextAction`), and side-chat dock callback. |
| `ui/app.js` | 665 | `<= 275` | Main Hangar state, `renderAll` view wiring, `loadHangarState` / `refreshHangarState` single-flight polling, and `IntersectionObserver` / visibility lifecycle. |
| `ui/components/tab-bar.js` | 437 | `<= 250` | Chrome Bar top/bottom strips using `AgyUI.reconcileTabStrip`, `AgyUI.setupStripScroll`, `AgyUI.bindTabDragController`, and `ns.apiCall('/api/terminal/rename', ...)`. |
| `ui/components/iframe-deck.js` | 334 | `<= 240` | Child sidecar iframe lifecycle, `<agy-split-sash>` / `AgyUI.bindSplitResize`, and `AgyUI.html` empty states. |
| `ui/components/extensions-tab.js` | 785 | `<= 260` | Extensions manager shell, `<agy-toggle-group>` sub-tabs, and store action handlers. |
| `ui/components/installed-pane.js` | *(split from `extensions-tab.js`)* | `<= 250` | Installed sidecar cards, scope toggle groups, workspace rule list, and auto-hibernate `<agy-switch>`. |
| `ui/components/marketplace-panes.js` | 450 | `<= 260` | Discover sidecars & Link Local folder panes rendered with `AgyUI.html`. |
| `ui/components/plugin-panes.js` | 269 | `<= 210` | Plugin marketplace & installed plugin cards rendered with `AgyUI.html`. |
| `ui/components/terminal-emulator.js` | 263 | `<= 263` | Terminal ANSI screen buffer & input sink (unchanged, already `< 300` lines). |
| `ui/components/terminal-tab.js` | 465 | `<= 260` | Terminal toolbar, session strip (`AgyUI.reconcileTabStrip`), and PTY polling without legacy fallback branches. |
| `ui/components/terminal-groups.js` | 385 | `<= 240` | Split terminal group stage, pane resizer (`AgyUI.bindSplitResize`), and tab drag (`AgyUI.bindTabDragController`). |
| `ui/components/terminal-quote.js` | 1564 | `<= 260` | Terminal text-selection quote popup & floating mini-composer rendered with `AgyUI.html`. |
| `ui/components/sidechat-store.js` | *(split from `terminal-quote.js`)* | `<= 240` | Side-chat cascade state, group management, custom title persistence, and Language Server annotation RPCs. |
| `ui/components/sidechat-strip.js` | *(split from `terminal-quote.js`)* | `<= 240` | Side-chat session pill strip (`AgyUI.reconcileTabStrip`, `AgyUI.startInlineRename`, `AgyUI.bindTabDragController`). |
| `ui/components/sidechat-pane.js` | *(split from `terminal-quote.js`)* | `<= 260` | Docked side-chat composer and embedded conversation iframe view. |

### 4.2 Unifying Tab Drag (`AgyUI.bindTabDragController`)
All three draggable tab strips in Hangar share the same in-rail math (already in `AgyUI.measureStrip` and `AgyUI.bindTabDragController`) and differ only in their out-of-rail drop targets:
1. **Chrome Bar (`tab-bar.js`):** Passes `onOutOfRailMove` (detects top/bottom split pane & terminal/side-chat slot hover preview) and `onDrop` (reorders within strip, moves between split panes, or docks into terminal/side-chat).
2. **Terminal Session Strip (`terminal-groups.js`):** Passes `onOutOfRailMove` (detects left/right split drop on `.term-pane` or pop-out to Chrome Bar) and `onDrop` (merges/splits terminal group or pops out `terminal__<tid>`).
3. **Side-Chat Strip (`sidechat-strip.js`):** Passes `onOutOfRailMove` (detects merge onto another chat pill or pop-out to Chrome Bar) and `onDrop` (reorders, merges group, or pops out `sidechat__<id>`).

### 4.3 Test Verification (`test/`)
- Update Hangar's test suite (`npm test`) to load the decomposed scripts and `linkedom` (`devDependency`) + `antigravity-sidecar-kit` v2:
  - Verify Chrome Bar tab rendering, overflow popover, inline rename (including authenticated `POST /api/terminal/rename`), and cross-pane drag-and-drop.
  - Verify Extensions Manager tabs (`Installed`, `Discover`, `Plugins`, `Link Local`) and `<agy-switch>` / `<agy-toggle-group>` interactions.
  - Verify Terminal session strip, split terminal groups, selection quote mini-composer, and Side-Chat strip/pane.
  - Assert that **every** UI and entrypoint file (`server.mjs` and `ui/**/*.{js,css,html}`) is `<= 300 lines`.

---

## 5. What Is Left to the Builder
- Exact function boundaries between `sidechat-store.js`, `sidechat-strip.js`, and `sidechat-pane.js`, provided all `window.Hangar` public methods called by `tab-bar.js`, `terminal-tab.js`, and `app.js` remain attached to `window.Hangar` and every file stays `<= 280 lines`.
