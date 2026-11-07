# Hangar & `antigravity-sidecar-kit` UI, UX & Accessibility (a11y) Audit Plan

> [!IMPORTANT]
> **Upstream-First Native Architecture**
> Per your direction, all shared component, stylesheet, theme, and custom-element fixes are targeted directly at the upstream [`antigravity-sidecar-kit`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit) repository (`lib/ui/**`) rather than patched via local workarounds in Hangar. Hangar-specific views (`ui/**` in [`antigravity-sidecar-hub`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub)) then consume the upgraded kit primitives cleanly while preserving 100% native Antigravity Auxiliary Pane fidelity.

---

## Executive Summary & Repository Ownership Matrix

| Area | Critical | High | Medium | Low | Primary Target |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **1. Global Design System, Theme & Focus Styles** | 1 (✅ Done) | 1 (✅ Done) | 2 (1 ✅ Done, 1 🚫 Wontfix) | 1 (✅ Done) | `sidecar-kit` (`theme.mjs`, `shell.css`, `theme-client.js`, `tabs.css`, `controls.css`, `overlays.css`, `layout.css`, `surfaces.css`) + `hangar` (`jetbox-proxy.mjs`, `styles.css`, `components.css`, `core.js`, `terminal-quote.js`) + `context-monitor` (`app.js`, `styles.css`, `components.css`, `context-drawers.js`, `subagent-drawer.js`) |
| **2. Chrome Bar, Tab Strips, Overflow Popover & Split Sash** | 2 (✅ Done) | 4 (✅ Done) | 2 (✅ Done) | 0 | `sidecar-kit` (`tab-pill.js`, `tab-strip.js`, `tab-drag.js`, `sync-client.js`, `overlays.js`, `layout.js`, `tabs.css`) + `hangar` (`index.html`, `app.js`, `tab-bar.js`, `iframe-deck.js`, `sidechat-strip.js`, `terminal-pane.js`, `terminal-drag.js`, `terminal-groups.js`, `jetbox-bootstrap.js`) |
| **3. Child Sidecar Iframe Deck** | 0 | 1 (✅ Done) | 1 (✅ Done) | 0 | `hangar` (`iframe-deck.js`, `terminal-pane.js`, `sidechat-pane.js`) |
| **4. Extensions Manager Shell & Settings Pane** | 0 | 2 (✅ Done) | 2 (✅ Done) | 0 | `sidecar-kit` (`toggle-group.js`) + `hangar` (`extensions-tab.js`, `installed-pane.js`, `marketplace-panes.js`) |
| **5. Installed Sidecars & Plugins Panes** | 1 (✅ Done) | 2 (✅ Done) | 2 (✅ Done) | 0 | `sidecar-kit` (`controls.js`, `toggle-group.js`) + `hangar` (`installed-pane.js`, `plugin-panes.js`, `components.css`) |
| **6. Marketplace (Discover & Sideload) Panes** | 0 | 0 | 2 (✅ Done) | 0 | `hangar` (`marketplace-panes.js`) |
| **7. Interactive Terminal, VT100 Emulator, Selection Quote & Mini-Composer** | 0 | 2 (✅ Done) | 2 (✅ Done) | 1 (✅ Done) | `sidecar-kit` (`overlays.js`) + `hangar` (`terminal-tab.js`, `terminal-pane.js`, `terminal-emulator.js`, `terminal-quote.js`, `sidechat-store.js`, `components.css`) |
| **8. Docked Side-Chat Pane** | 0 | 1 (✅ Done) | 0 | 1 (✅ Done) | `hangar` (`sidechat-pane.js`, `sidechat-strip.js`, `components.css`) |
| **Total** | **4 (✅ Done)** | **13 (✅ Done)** | **13 (12 ✅ Done, 1 🚫 Wontfix)** | **3 (✅ Done)** | **16 files in `antigravity-sidecar-kit` + 21 files in `antigravity-sidecar-hub` + 5 files in `antigravity-context-monitor`** |

---

## 1. Global Design System, Theme & Focus Styles

### [DONE] [Critical] 1.1 Global suppression of `:focus-visible` outlines across interactive controls (WCAG 2.4.7)
- **Status**: ✅ **Completed** across all 3 repositories (`antigravity-sidecar-kit` `a3a518d`, `antigravity-sidecar-hub` `b1b545d`, `antigravity-context-monitor` `9451eeb`).
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**:
    - [`lib/theme.mjs:407-415`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/theme.mjs#L407-L415) (`fetchHostStylesheet`)
    - [`lib/ui/shell/shell.css:20-141`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css#L20-L141) (`--nux-focus-ring`, baseline `:focus-visible`)
    - [`lib/ui/shell/theme-client.js:160-256`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/theme-client.js#L160-L256) (`data-agy-theme`, `data-newux-theme`)
    - [`lib/ui/tabs/tab-pill.js:85-185`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-pill.js#L85-L185) & [`lib/ui/tabs/tab-strip.js:60-73`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L60-L73)
    - [`lib/ui/tabs/tabs.css:58,220-245,297,404`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css#L58) (`.agy-tab`, `.agy-tab-pin`, `.agy-tab-close`, `.agy-tab-add`, `.agy-tab-overflow-item`, `.agy-toggle-item`)
    - [`lib/ui/controls/controls.css:2-65,143,251`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.css#L2-L65) (`.agy-icon-btn`, `.agy-btn`, `.agy-switch`, `.agy-select`)
    - [`lib/ui/overlays/overlays.css:34-48`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.css#L34-L48) (`.agy-context-menu-item`)
    - [`lib/ui/layout/layout.css:21-72`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/layout/layout.css#L21-L72) (`.agy-chrome-bar .agy-icon-btn`, `agy-split-sash`, `.agy-split-sash`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`lib/jetbox-proxy.mjs:388-397`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/lib/jetbox-proxy.mjs#L388-L397) (removed duplicate unlayered `/compiled_tailwind.css` route)
    - [`ui/components.css:263-281,370-388,625-652,731-788,927-995`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L263-L281) (`.ws-rule-remove`, `.term-pane-close`, `.term-quote-btn`, `.term-sidechat-select`, `.term-sidechat-main-btn`, `.term-quote-composer-close`, `.term-mini-*`, `.port-report summary`, `.term-pane-resizer`)
    - [`ui/components/sidechat-pane.js:218-224`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L218-L224) (`newThreadBtn` `18px` `add` icon)
  - **Context Monitor (`antigravity-context-monitor`)**:
    - [`ui/components/subagent-drawer.js:70-72,196-198`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components/subagent-drawer.js#L70-L72) (`.subagent-card`, `#subagents-collapse-toggle`)
    - [`ui/components/context-drawers.js:96,144,234,258,304`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components/context-drawers.js#L96) (`#mcp-collapse-toggle`, `#compactions-collapse-toggle`, `#effort-fit-collapse-toggle`, `.subagent-culprit.clickable`, `#culprits-collapse-toggle`)
    - [`ui/app.js:130-165,247-255`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/app.js#L130-L165) (keyboard `Enter`/`Space` activation and focus restoration across `setHtml` re-renders)
    - [`ui/styles.css:476-520`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/styles.css#L476-L520) & [`ui/components.css:55-58,182-185,358-378,604-652`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components.css#L55-L58)
- **Issue**: `antigravity-sidecar-kit` set `outline: none;` on `.agy-tab`, `.agy-btn`, `.agy-toggle-item`, `.agy-tab-overflow-item`, and `.agy-select` without providing a `:focus-visible` ring. Hangar's `ui/components.css` similarly suppressed outlines or omitted `:focus-visible` on terminal and workspace controls, and Context Monitor's `.collapsible-toggle` drawer headers lacked `tabindex="0"`, `role="button"`, and `aria-expanded`.
- **Deviations from Initial Plan & Additional Changes Implemented**:
  1. **Native NewUX Focus Ring Token & Geometry (`--nux-focus-ring`, `2px solid`, `outline-offset: 2px`)**:
     - Instead of the initially proposed `1.5px solid var(--agy-accent); outline-offset: -1.5px;`, live inspection of native Antigravity (`body[data-agy-theme][data-newux-theme] :is(button, input, select, textarea, a, [tabindex]):focus-visible:not(.no-focus-ring)` in `/compiled_tailwind.css`) showed that native Antigravity uses an outer `2px solid var(--nux-focus-ring); outline-offset: 2px;` ring (`outline-offset: 1px` on nested `.agy-tab-pin` and `.agy-tab-close`), where `--nux-focus-ring` is `color-mix(in srgb, var(--agy-accent) 55%, transparent)` (`Highlight` under `@media (forced-colors: active)`).
     - Added `--nux-focus-ring` and baseline `:is(button, input, select, textarea, a, summary, [tabindex]):focus-visible:not(.no-focus-ring)` in [`shell.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css#L20-L141) and synced `data-agy-theme=""` and `data-newux-theme` on `document.body` in [`theme-client.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/theme-client.js#L160-L256).
  2. **CSS Cascade Level 5 `@layer` `!important` Inversion & Duplicate `/compiled_tailwind.css` Route Overwrite**:
     - Upstream `/compiled_tailwind.css` contains `button:focus-visible { outline: none !important; }` alongside `:focus-visible { outline: none; }`. Under CSS Cascade Level 5, `!important` rules inside an earlier `@layer agy-host` override normal unlayered sidecar rules. Updated [`fetchHostStylesheet`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/theme.mjs#L407-L415) in `antigravity-sidecar-kit/lib/theme.mjs` to strip `!important` when wrapping `/compiled_tailwind.css` in `@layer agy-host`.
     - Removed the duplicate `/compiled_tailwind.css` route in [`lib/jetbox-proxy.mjs`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/lib/jetbox-proxy.mjs#L388-L397) that was overwriting [`server.mjs:37`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/server.mjs#L37)'s `createAgyCssHandler` with raw unlayered CSS.
  3. **Keyboard-Focusable `.agy-tab-pin` & `.agy-tab-close` Sub-Buttons (Pulled forward from Finding 2.1)**:
     - To match native Antigravity `.agy-aux-tab` where Tab moves focus from the tab pill onto its inner pin/close button, updated [`tab-pill.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-pill.js#L85-L185) to add `role="button"`, `aria-label` (`Unpin tab` / `Close tab`), `tabindex="0"` (`-1` when hidden), and `Enter`/`Space` activation to `.agy-tab-pin` and `.agy-tab-close`.
  4. **NewUX Rounded Pill `+` Button (`28px × 28px`, `18px` SVG) & `.agy-icon-btn` / `.agy-btn` Parity**:
     - Native Antigravity updated `[data-testid="side-panel-new-tab-button"]` (`.agy-button-icon-lg`) to a `28px × 28px` circular button (`border-radius: var(--nux-radius-pill, 9999px)`, `margin-left: 0`, `color: var(--secondary-foreground)`, `18px × 18px` Material Symbols Rounded `add` SVG). Updated `.agy-tab-add, .agy-tab-add-btn, .agy-icon-btn.agy-tab-add, .agy-icon-btn.agy-tab-add-btn` in [`tabs.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css#L235-L245) (with `(0, 2, 0)` specificity so `controls.css` does not override secondary tab strips), `.agy-chrome-bar .agy-icon-btn:not(.has-hidden-tabs)` in [`layout.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/layout/layout.css#L21-L24), `.agy-icon-btn` and `.agy-btn` in [`controls.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.css#L2-L55), and `18px` `add` icons + `aria-label` in [`tab-strip.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L60-L73) and [`sidechat-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L218-L224).
  5. **Cross-Repository `antigravity-context-monitor` Collapsible Drawer Focus & ARIA Parity**:
     - Added `role="button"`, `tabindex="0"`, and `aria-expanded` to all 5 `.collapsible-toggle` rows (`#subagents-collapse-toggle`, `#mcp-collapse-toggle`, `#compactions-collapse-toggle`, `#effort-fit-collapse-toggle`, `#culprits-collapse-toggle`) and `.subagent-card` / `.subagent-culprit.clickable` in [`subagent-drawer.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components/subagent-drawer.js) and [`context-drawers.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components/context-drawers.js), added `Enter`/`Space` keydown handling and focus restoration across `setHtml` updates in [`ui/app.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/app.js), and aligned all `:focus-visible` outlines in [`ui/styles.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/styles.css) and [`ui/components.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components.css) to `2px solid var(--nux-focus-ring, var(--cm-accent)); outline-offset: 2px;`.

### [DONE] [High] 1.2 Desynchronized light/dark theme detection on startup and incomplete `forced-colors` tokens
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**:
    - [`lib/ui/shell/theme-client.js:152-175,252-268`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/theme-client.js#L152-L175) (`syncAgyThemeAttributes`, `applyAgyThemeFromPayload`)
    - [`lib/ui/shell/shell.css:117-141`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css#L117-L141) (`@media (forced-colors: active)`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/components/iframe-deck.js:50-58`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L50-L58) (`applyThemePayload`)
    - [`ui/components/sidechat-pane.js:8`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L8) & [`ui/components/terminal-pane.js:259`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L259)
    - [`ui/styles.css:178-199`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/styles.css#L178-L199)
- **Implementation Summary**:
  1. Synchronized `root.style.colorScheme = nextTheme` and `document.body?.classList` (`theme-light` / `theme-dark` / `dark`) inside both `syncAgyThemeAttributes` and `applyAgyThemeFromPayload` in [`theme-client.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/theme-client.js#L152-L268).
  2. Added `--agy-card-edge`, `--agy-sunken`, `--agy-control`, `--agy-hover`, `--nux-focus-ring`, `--agy-ok`, `--agy-warn`, and `--agy-err` under `@media (forced-colors: active)` in [`shell.css:117-141`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css#L117-L141).
  3. Updated [`sidechat-pane.js:8`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L8) and [`terminal-pane.js:259`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L259) to use `window.AgyShell ? !window.AgyShell.isHostDarkTheme() : Boolean(document.body?.classList?.contains?.('theme-light'))`.

### [DONE] [Medium] 1.3 Deep-link highlight class `.agy-card-highlight` is undefined and never cleaned up
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/surfaces/surfaces.css:10-47`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/surfaces/surfaces.css#L10-L47) (`@keyframes agy-card-pulse`, `.agy-card.agy-card-highlight`, `.agy-card.agy-card-highlight.agy-card-highlight-settled`)
  - **Hangar (`antigravity-sidecar-hub`)**: [`ui/core.js:177-254`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/core.js#L177-L254) (`handleHangarNavigateMessage`)
- **Implementation Summary**:
  1. Added a `1.4s` double-pulse `@keyframes agy-card-pulse` (`0–18%` pulse 1 -> `30–38%` dip -> `50–75%` pulse 2 -> `100%` persistent resting highlight with `border-color: var(--agy-accent)`, `box-shadow: 0 0 0 1px var(--agy-accent-soft)`, and `5%` accent surface tint) plus `.agy-card-highlight-settled { animation: none; }` in [`surfaces.css:10-47`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/surfaces/surfaces.css#L10-L47).
  2. Updated `handleHangarNavigateMessage` in [`ui/core.js:177-254`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/core.js#L177-L254) to:
     - Clear any previous `.agy-card-highlight` / `.agy-card-highlight-settled` before switching tabs.
     - Listen for `scrollend` on `#store-view` (`450ms` window) so if smooth scrolling occurred, the double-pulse restarts once the card is centered in the viewport.
     - Transition to `.agy-card-highlight-settled` (`animation: none`) on `animationend` so the card keeps its resting target highlight without re-flashing if the view is hidden/shown, and dismiss the highlight on `pointerdown` / `keydown` or the next navigation.

### [WONTFIX — Intentional Native Parity] [Medium] 1.4 Opacity on shortcut badges (`.term-quote-kbd`, `.term-mini-kbd`)
- **Status**: 🚫 **Closed / Wontfix (Intentional Native Antigravity Parity)** — Visual styles kept untouched; ARIA & audit-hardening committed in `antigravity-sidecar-hub` `0644dec`.
- **Location**:
  - [`ui/components.css:698-703`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L698-L703) (`.term-quote-kbd`) and [`ui/components/terminal-quote.js:368-373,500-511`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-quote.js#L368-L373)
  - [`ui/components.css:1020-1027`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L1020-L1027) (`.term-mini-kbd`)
  - [`test/state-sync-hangar.test.mjs:34-44`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/test/state-sync-hangar.test.mjs#L34-L44)
- **Why Closed / Rejection of Original Audit Finding**:
  1. **False CSS Cascade Premise**: `.term-quote-kbd` and `.opacity-50` sat on the **same `<span>` element** (`<span class="term-quote-kbd text-xs opacity-50">`), not nested parent/child elements. CSS `opacity` does not multiply across classes on a single DOM node; unlayered `.term-quote-kbd { opacity: 0.55; }` overrode `@layer agy-host`'s `.opacity-50 { opacity: 0.5; }` (`getComputedStyle(el).opacity === "0.55"`, not `0.275`).
  2. **1:1 Upstream Antigravity Provenance**:
     - Upstream `/main.js` renders all three native selection Quote popups — Terminal (`Hmc` at byte offset `7520829..7521775`, formerly minified as `y9b`), Editor/Artifact (`4314710..4315680`), and Chat (`BDc` at `8254200..8255050`) — with literal `A.createElement("span", { className: "text-xs opacity-50" }, shortcutLabel)` inheriting `text-foreground` (`--hub-fg`) on `--card` (`--hub-card`).
     - Upstream `/main.js` renders inline action-button shortcut suffixes using `opacity-60 text-xs` (`rename-conversation-submit` at offset `7613952`) or `text-xs opacity-50` (`proceed-button` at `7279738`, interaction submit at `6473060`), which `.term-mini-kbd { opacity: 0.6; }` directly mirrors.
  3. **Visual Hierarchy Preservation & Audit Hardening (`0644dec`)**: `.term-mini-sidechat-btn` uses `.agy-btn-outline` ([`controls.css:125`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.css#L125)), whose base text color is already `var(--agy-ink-soft)` (`--hub-muted`). Replacing `.term-mini-kbd`'s `opacity: 0.6` with `color: var(--hub-muted); opacity: 1` (or `0.85`) flattens the contrast hierarchy between the primary button label (`"Ask in Side Chat"`) and its supplementary shortcut suffix (`"Ctrl+↵"`). Removed the redundant `text-xs opacity-50` classes from `.term-quote-kbd`, marked both `.term-quote-kbd` and `.term-mini-kbd` with `aria-hidden="true"`, added `aria-keyshortcuts` to their parent buttons, added provenance comments in `ui/components.css`, and locked in regression tests in `test/state-sync-hangar.test.mjs`.

### [DONE] [Low] 1.5 Unstyled scrollbars in scrollable panes/textareas and missing `prefers-reduced-motion` support
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/shell/shell.css:151-179`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css#L151-L179) (`*::-webkit-scrollbar*`)
  - **Hangar (`antigravity-sidecar-hub`)**: [`ui/components.css:605-609`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L605-L609) (`@media (prefers-reduced-motion: reduce)`)
- **Implementation Summary**:
  1. Styled `*::-webkit-scrollbar` in [`shell.css:151-179`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css#L151-L179) to match Antigravity's native `[data-testid="overlay-scrollbar-thumb"]` (`6px` width/height, `border-radius: 9999px`, `rgba(128, 128, 128, 0.38)` thumb, `rgba(128, 128, 128, 0.62)` hover/active, `transparent` track, `CanvasText` under `forced-colors: active`).
  2. Disabled `.term-cursor` blink under `@media (prefers-reduced-motion: reduce)` in [`ui/components.css:605-609`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L605-L609).

---

## 2. Chrome Bar, Tab Strips, Overflow Popover & Split Sash

### [DONE] [Critical] 2.1 Tab strips and tab pills lack `role="tablist"`, `role="tab"`, `aria-selected`, keyboard arrow navigation, unlabeled `+` buttons, and keyboard tab-close/unpin (WCAG 2.1.1 / 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**:
    - [`lib/ui/tabs/tab-pill.js:85-209`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-pill.js#L85-L209) (`ensurePillSlots`, `createTabPill`, `updateTabPill`)
    - [`lib/ui/tabs/tab-strip.js:17-105,263-273`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L17-L105) (`bindTabStripKeydown`, `reconcileTabStrip`, `AgyTabStripElement`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/components/terminal-tab.js:29`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-tab.js#L29) (`<agy-tab-strip data-role="sessions" aria-label="Terminal sessions">`)
    - [`ui/components/sidechat-pane.js:118-119`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L118-L119) (`sessionsEl.setAttribute('aria-label', 'Side Chat threads')`)
- **Implementation Summary & Deviation Note**:
  1. Added `role="tablist"` to `<agy-tab-strip>` in both `reconcileTabStrip` and `AgyTabStripElement.connectedCallback()`, and `role="tab"` + `aria-selected="true|false"` to `.agy-tab` in `updateTabPill`.
  2. Added `Delete` key handling on `.agy-tab` (`e.target === host`) to close closable unpinned tabs, and `bindTabStripKeydown(stripEl)` supporting `ArrowLeft`, `ArrowRight`, `Home`, and `End` navigation across `.agy-tab` pills.
  3. **Deviation**: Kept `.agy-tab` buttons in the natural `tabindex="0"` sequence (matching native Antigravity `.agy-aux-tab`) rather than setting `tabindex="-1"` on inactive tabs, because `.agy-tab-pin` and `.agy-tab-close` inside each pill are keyboard-focusable (`tabindex="0"`), so setting `tabindex="-1"` on inactive `.agy-tab` pills would cause `Tab` to skip the tab pill while landing on its inner close/pin button. Both `Tab` and `ArrowLeft`/`ArrowRight`/`Home`/`End` now work seamlessly.
  4. Added `aria-label="Terminal sessions"` and `aria-label="Side Chat threads"` to Hangar's secondary tab strips, and ensured `addBtn` updates `aria-label` on re-render.

### [DONE] [Critical] 2.2 Split resize sash (`<agy-split-sash>`) is mouse-only and double-bound (WCAG 2.1.1 / 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/layout/layout.js:8-157`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/layout/layout.js#L8-L157) (`bindSplitResize`, `AgySplitSashElement`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/index.html:91-102`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/index.html#L91-L102) (`#split-resize-handle`)
    - [`ui/app.js:330-354`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/app.js#L330-L354)
- **Implementation Summary & Deviation Note**:
  1. **In `antigravity-sidecar-kit` ([`lib/ui/layout/layout.js:8-157`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/layout/layout.js#L8-L157))**:
     - Called `handleEl._cleanupResize?.()` at the start of `bindSplitResize` and returned a full `cleanup()` function removing `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, and `keydown` listeners so re-binding `#split-resize-handle` in `ui/app.js` replaces `AgySplitSashElement.connectedCallback()`'s default binding without firing duplicate events.
     - Set default `role="separator"`, `tabindex="0"`, `aria-orientation` (`"vertical"` for horizontal splits, `"horizontal"` for vertical splits), and `aria-valuemin` / `aria-valuemax` / `aria-valuenow` attributes.
     - Added `keydown` support (`ArrowUp`/`ArrowDown` for vertical splits, `ArrowLeft`/`ArrowRight` for horizontal splits, plus `Home`/`End` and `Shift` 40px steps) synthesizing `onResizeStart`, `onResize(nextRatio, moveEv)`, and `onResizeEnd` events.
  2. **In Hangar ([`ui/index.html:91-102`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/index.html#L91-L102))**:
     - Added `tabindex="0"` and `aria-label="Resize top and bottom split panes"` to `#split-resize-handle` in `ui/index.html`.
  3. **Deviation**: Omitted keyboard resizing / `tabindex="0"` on `.term-pane-resizer` in [`terminal-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L80-L96) because terminal panes capture `Tab` as shell input, making a keyboard resizer between side-by-side terminal panes unreachable via `Tab`.

### [DONE] [High] 2.3 `#split-toggle-btn` missing `aria-pressed` state (WCAG 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/index.html:74-84`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/index.html#L74-L84), [`ui/components/tab-bar.js:342-345,353-359`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/tab-bar.js#L342-L345)
- **Issue**: `syncChromeBtn` in [`tab-bar.js:353-359`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/tab-bar.js#L353-L359) sets `aria-pressed` on `#terminal-toggle-btn` and `#extensions-toggle-btn`, but `splitBtnEl` only toggled `.active` without updating `aria-pressed`.
- **Implementation Summary**:
  Updated `renderTabBar` in [`ui/components/tab-bar.js:342-345`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/tab-bar.js#L342-L345) to set `splitBtnEl.setAttribute?.('aria-pressed', String(splitEnabled))` alongside `splitBtnEl.classList.toggle('active', splitEnabled)`, and added regression coverage in [`test/ui-polling-layout.test.mjs:404-423`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/test/ui-polling-layout.test.mjs#L404-L423).

### [DONE] [High] 2.4 Context menu (`.agy-context-menu`) and Tab Overflow Popover (`.agy-tab-overflow-popover`) do not move or restore focus on open/close (WCAG 2.1.1 / 2.4.3)
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**:
    - [`lib/ui/overlays/overlays.js:5-160`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.js#L5-L160) (`closeContextMenu`, `openContextMenu`)
    - [`lib/ui/tabs/tab-strip.js:237-413`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L237-L413) (`setupStripScroll`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/components/tab-bar.js:221-227`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/tab-bar.js#L221-L227) (`addBtn` context menu anchor `target`)
- **Implementation Summary**:
  1. **In `antigravity-sidecar-kit` ([`lib/ui/overlays/overlays.js:5-160`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.js#L5-L160))**:
     - Captured `prevMenuFocus` from `doc.activeElement` (when outside any active menu) or `anchorOrEvent` (`target` / `currentTarget` / element) in `openContextMenu`.
     - Focused `enabledBtns[0]` (`focusIdx = 0`) immediately upon mounting `.agy-context-menu`.
     - Updated `closeContextMenu(restoreFocus = false)` and the `Escape` key handler to restore focus to `prevMenuFocus`.
  2. **In `antigravity-sidecar-kit` ([`lib/ui/tabs/tab-strip.js:237-413`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L237-L413))**:
     - Set `aria-haspopup="menu"` and `aria-expanded="false"` on `cfg.overflowBtn`, `role="menu"` on `cfg.popoverEl`, `role="menuitem"` on `.agy-tab-overflow-item` buttons, and `role="presentation"` on `.agy-tab-overflow-section` headers.
     - Tracked `_activeTriggerBtn` on `cfg.popoverEl` (supporting shared popovers across top and bottom strips), synced `aria-expanded="true|false"` across open, item click, toggle close, and `Escape`, focused the active (or first) `.agy-tab-overflow-item` on `showPopover()`, and bound `ArrowDown`, `ArrowUp`, `Home`, `End`, and `Escape` on `cfg.popoverEl` (restoring focus to `_activeTriggerBtn` on `Escape`).
  3. **In Hangar ([`ui/components/tab-bar.js:221-227`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/tab-bar.js#L221-L227))**:
     - Passed `target: addBtn` in the `+` button's anchor descriptor so `Escape` restores focus directly to `addBtn`.

### [DONE] [Medium] 2.5 `.agy-tab-label` `max-width: 200px` starves tab bar in narrow (260px–320px) Auxiliary Panes
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/tabs/tabs.css:94-115`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css#L94-L115) (`.agy-tab-label`)
- **Issue**: At a 260px Auxiliary Pane width, `.chrome-actions` takes ~76px and `#top-overflow-btn` takes 26px, leaving ~148px for `#tab-strip`. Because `.agy-tab-label` allows `max-width: 200px`, a single tab with a moderately long title consumes the entire strip.
- **Implemented Fix**:
  Added `@media (max-width: 360px) { .agy-tab-label { max-width: 110px; } }` in [`antigravity-sidecar-kit/lib/ui/tabs/tabs.css:111-115`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css#L111-L115).

### [DONE] [Medium] 2.6 Tab close button (`.agy-tab-close`) hit target is only `18×18px`
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/tabs/tabs.css:167-183,215-230`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css#L167-L183) (`.agy-tab-close-wrap`, `.agy-tab-close`)
- **Issue**: `.agy-tab-close` wrapped a `14×14px` SVG with `padding: 2px` (`18×18px` total), falling below the WCAG 2.2 AA target size in a `28px`-tall `.agy-tab`.
- **Implementation Summary**:
  Added `min-width: 22px; min-height: 22px;` to `.agy-tab-close` (`lines 215-230`) and adjusted `.agy-tab-close-wrap` `padding-right` from `6px` to `4px` (`line 176`) in [`antigravity-sidecar-kit/lib/ui/tabs/tabs.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css#L167-L230) so the `14×14px` close icon remains at the exact same horizontal pixel offset (`15px` center from right edge) while expanding the interactive hit area from `18×18px` to `22×22px`. Added regression assertion in [`test/ui-core-routes.test.mjs:91`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/test/ui-core-routes.test.mjs#L91).

### [DONE] [High] 2.7 Terminal split/unsplit duplicate `groupId` collision, outermost slot (`index 0` / last) drag-reordering, and `+` button slot shifting
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/tab-drag/tab-drag.js:13-87,188-265`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tab-drag/tab-drag.js#L13-L87) (`getUnshiftedRect`, `measureStrip`, `bindTabDragController`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/components/terminal-drag.js:69-90,314-316,423-453`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-drag.js#L69-L90) (`applyTerminalDrop`, `clearAllTermDropIndicators`, `checkOwnTarget`)
    - [`ui/components/terminal-groups.js:50-95`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-groups.js#L50-L95) (`normalizeTabGroups`)
    - [`ui/components/sidechat-strip.js:119-127,181-194,251-259`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-strip.js#L181-L259) (`inspectHangarPointerOverInstance`, `bindSideChatPointerDrag`)
    - [`ui/components/iframe-deck.js:225-232`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L225-L232) (`bindInstanceStripDrag`)
- **Implementation Summary**:
  1. **Duplicate `groupId` collision on unsplit**: In [`applyTerminalDrop`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-drag.js#L69-L90), when a pane whose `terminalId` matches its group's `groupId` is dragged out of a split group (`g.paneIds.length >= 1`), the remaining group's `groupId` is reassigned to `g.paneIds[0]` (unless already taken) before inserting the extracted pane's new group `{ groupId: srcTid }`, and [`normalizeTabGroups`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-groups.js#L50-L95) enforces unique `groupId`s across all groups.
  2. **Unshifted tab geometry & non-strip (`draggedIndex === -1`) out-of-rail guard**: Updated [`getUnshiftedRect`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tab-drag/tab-drag.js#L13-L41) to parse computed `matrix()`/`matrix3d()` `tx` offsets when `_shiftX` is unset, and guarded out-of-rail negative shifts in [`terminal-drag.js:445-449`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-drag.js#L445-L449) and [`sidechat-strip.js:251-259`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-strip.js#L251-L259) so dragging a split pane (`draggedIndex === -1`) never shifts strip tabs by `-draggedSlot`.
  3. **Outermost slot (`index 0` and `last`) drag-reordering**: Updated [`tab-drag.js:188-216`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tab-drag/tab-drag.js#L188-L216) to compute unclamped `rawLeft` and `rawCenter` before clamping `left` to `[minLeft, maxLeft]`, skip `i === dragState.draggedIndex`, use directional span thresholds (`0.65` moving left, `0.35` moving right), and test `probeX = i < dragState.draggedIndex ? Math.min(e.clientX, rawCenter) : Math.max(e.clientX, rawCenter)`. Fixed rightward `beforeId` index mapping in [`iframe-deck.js:225-232`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L225-L232).
  4. **`+` button (`addBtn`) slot shifting during split-pane drag-to-strip**: Captured `addBtn` in [`measureStrip`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tab-drag/tab-drag.js#L43-L87) (`dragState.addBtn`) and shifted `dragState.addBtn` right by `+shiftPx` in [`checkOwnTarget`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-drag.js#L423-L453) whenever a split pane hovers any slot on `sessionsEl` (including the last slot after `tab4`), using `dragState.rects[i].right - scrollDelta` slot boundaries so the open drop gap and `+` button position stay aligned across all `N + 1` slots.

### [DONE] [High] 2.8 Missing native `Ctrl+Tab` / `Ctrl+Shift+Tab` and `Ctrl/Cmd+Shift+.` / `Ctrl/Cmd+Shift+,` visual-order tab cycling and cross-iframe shortcut forwarding (WCAG 2.1.1)
- **Status**: ✅ **Completed** in `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**:
    - [`lib/ui/tabs/tab-strip.js:38-126`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L38-L126) (`matchTabCycleShortcut`, `cycleTabStrip`, `bindGlobalTabCycleKeydown`)
    - [`lib/ui/shell/sync-client.js:305-359`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/sync-client.js#L305-L359) (`matchTabCycleShortcut`, `bindParentShortcutForwarder`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/app.js:407-469`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/app.js#L407-L469) (`resolveElementSlot`, `resolveWindowSlot`, `bindGlobalTabCycleKeydown`)
    - [`ui/jetbox/jetbox-bootstrap.js:302-336`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/jetbox/jetbox-bootstrap.js#L302-L336) (`matchAuxTabCycleShortcut`, capture-phase `keydown` forwarder)
- **Issue**:
  1. Finding 2.1 added `ArrowLeft`/`ArrowRight`/`Home`/`End` navigation when a `.agy-tab` button itself has DOM focus, **but** neither `antigravity-sidecar-kit` nor Hangar bound `Ctrl+Tab` / `Ctrl+Shift+Tab` (or `Ctrl/Cmd+Shift+.` / `Ctrl/Cmd+Shift+,`) to cycle Auxiliary Pane tabs globally regardless of where focus is inside the pane.
  2. When focus is inside a child sidecar `<iframe>` (e.g., Context Monitor) or a Jetbox `<iframe>` (`/jetbox-terminal` or `/jetbox-chat`), `keydown` events do not bubble across the iframe boundary to Hangar's `document.documentElement` (and inside `/jetbox-chat`, Jetbox's own capture listener intercepts `Ctrl+Tab` for its hidden inner side panel).
- **Implementation Summary**:
  1. **In `antigravity-sidecar-kit` ([`lib/ui/tabs/tab-strip.js:38-126`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js#L38-L126))**:
     - Added `ui.matchTabCycleShortcut(e)` matching `Ctrl+Tab` (`1`), `Ctrl+Shift+Tab` (`-1`), `Ctrl/Cmd+Shift+Period` (`1`), and `Ctrl/Cmd+Shift+Comma` (`-1`) with strict modifier and `!AltGraph` checks.
     - Added `ui.cycleTabStrip(stripEl, dir)` cycling enabled `.agy-tab` pills in visual DOM order with modulo wrap-around and scrolling the newly selected tab pill into view (`inline: 'start' | 'nearest' | 'end'`) without moving DOM focus onto the tab button.
     - Added `ui.bindGlobalTabCycleKeydown(stripOrResolver, opts)` attaching a capture-phase `keydown` listener on `document.documentElement` (with `!e.repeat` guard) plus a `window` `message` listener for `{ type: 'agy:shortcut-forwarded' }` events from child iframes.
  2. **In `antigravity-sidecar-kit` ([`lib/ui/shell/sync-client.js:305-359`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/sync-client.js#L305-L359))**:
     - Added `bindParentShortcutForwarder()` so child sidecar iframes (`window.parent !== window` without a local `_hasLocalTabCycleHandler`) forward `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl/Cmd+Shift+.`, and `Ctrl/Cmd+Shift+,` via `window.parent.postMessage({ type: 'agy:shortcut-forwarded', dir, repeat }, '*')`.
  3. **In Hangar ([`ui/app.js:407-469`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/app.js#L407-L469), [`ui/jetbox/jetbox-bootstrap.js:302-336`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/jetbox/jetbox-bootstrap.js#L302-L336))**:
     - Tracked `lastFocusedSlot` (`'top'` vs `'bottom'`) across `pointerdown`, `focusin`, `window` `blur`, and child iframe `e.source` windows, routing `bindGlobalTabCycleKeydown` to `els.bottomTabStrip` when split view is active and the bottom split has focus, and `els.tabStrip` otherwise, while blurring any newly hidden `<iframe>` and focusing Hangar's `window` on cycle.
     - Registered a `window` capture-phase `keydown` listener in [`ui/jetbox/jetbox-bootstrap.js:302-336`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/jetbox/jetbox-bootstrap.js#L302-L336) (before `jetbox-main.js`) that intercepts `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Ctrl/Cmd+Shift+.` / `Ctrl/Cmd+Shift+,`, calls `e.preventDefault(); e.stopImmediatePropagation()`, and posts `agy:shortcut-forwarded` to `window.parent`.

---

## 3. Child Sidecar Iframe Deck
**Files**: [`ui/components/iframe-deck.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js), [`ui/components/terminal-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js), [`ui/components/sidechat-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js)

### [DONE] [High] 3.1 All `<iframe>` elements across Iframe Deck, Terminal, and Side-Chat lack `title` attributes (WCAG 2.4.1 / 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**:
  - [`ui/components/iframe-deck.js:265-287`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L265-L287) (`.child-sidecar-frame`)
  - [`ui/components/terminal-pane.js:304-345`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L304-L345) (`.term-jetbox-frame`)
  - [`ui/components/sidechat-pane.js:374-382`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L374-L382) (`.term-sidechat-frame`)
- **Issue**: All dynamically created `<iframe>` elements omitted the `title` attribute, causing screen readers to fall back to reading the raw `src` URL (`/?conversationId=...` or `/jetbox-terminal?...`).
- **Implementation Summary**:
  1. In [`ui/components/iframe-deck.js:265-287`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L265-L287), set `title: `${sc.displayName || sc.sidecarId} Sidecar`` on creation and kept `frame.title` synchronized on subsequent reconciles.
  2. In [`ui/components/terminal-pane.js:304-345`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L304-L345), set `title: `Interactive Terminal (${cleanTitle})`` on `.term-jetbox-frame` creation and updated `p.frame.title` whenever `cleanTitle` changes.
  3. In [`ui/components/sidechat-pane.js:374-382`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L374-L382), set `title: 'Docked Side Chat'` in `createFrame`.
  4. Added regression assertions in [`test/ui-polling-layout.test.mjs:434-465`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/test/ui-polling-layout.test.mjs#L434-L465).

### [DONE] [Medium] 3.2 Hibernated/stopped sidecar empty state offers no inline Wake/Enable button
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**:
  - [`ui/components/iframe-deck.js:238,313-348`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L313-L348) (`reconcileIframeDeck`, `syncEmpty`)
  - [`ui/app.js:84`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/app.js#L84) (`renderAll`)
  - [`ui/styles.css:96-108`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/styles.css#L96-L108) (`.empty-split-zone`)
- **Issue**: When an open tab pointed to a hibernated or stopped sidecar (`slotId` is truthy, `mounted` is false), `#empty-top-state` / `#empty-deck-state` rendered static text (`"Sidecar is hibernated or stopped — enable it in 🧩 Extensions"`), forcing the user to manually switch to Extensions, locate the sidecar card, and flip its switch.
- **Implementation Summary**:
  1. In [`ui/components/iframe-deck.js:313-348`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js#L313-L348), rendered an inline `<button type="button" class="agy-btn agy-btn-primary has-icon" data-role="enable-sidecar">` (`"Enable Sidecar"` with `play_arrow` icon) inside `.empty-split-zone` whenever `slotId` is non-empty, calling `ns.apiCall('/api/sidecar/manage', { sidecarId: slotId, action: 'SIDECAR_ACTION_ENABLE' })` followed by `onRefreshState?.()`.
  2. Passed `onRefreshState: refreshHangarState` to `reconcileIframeDeck` in [`ui/app.js:84`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/app.js#L84) and added `flex-direction: column; gap: 10px;` to `.empty-split-zone` in [`ui/styles.css:96-108`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/styles.css#L96-L108).
  3. Added regression assertions in [`test/ui-polling-layout.test.mjs:466-515`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/test/ui-polling-layout.test.mjs#L466-L515).

---

## 4. Extensions Manager Shell & Settings Pane

### [DONE] [High] 4.1 `<agy-toggle-group>` buttons in Settings and Sub-tabs lack `data-role`/`data-ttl` key recognition and valid ARIA roles, breaking `aria-selected` sync and keyboard arrow activation (WCAG 2.1.1 / 4.1.2)
- **Status**: ✅ **Completed** across `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/tabs/toggle-group.js:8-74,200-290`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/toggle-group.js#L8-L74) (`getButtonKey`, `syncToggleItemAria`, `applyToggleSelection`, `AgyToggleGroupElement`)
  - **Hangar (`antigravity-sidecar-hub`)**: [`ui/components/extensions-tab.js:124-190,284,318,446-455`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/extensions-tab.js#L124-L190) (`renderSettingsPane`, `renderExtensionsTab`)
- **Implementation Summary**:
  1. **In `antigravity-sidecar-kit` ([`lib/ui/tabs/toggle-group.js:8-74,200-290`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/toggle-group.js#L8-L74))**:
     - Added `b?.dataset?.ttl` to `getButtonKey(b)` while keeping `data-role`-only buttons as non-auto-activating roving items (preserving `roleOnlyTg` behavior).
     - Added `syncToggleItemAria(containerEl, b, isSel)` setting child `role="tab"` + `aria-selected` when the container has `role="tablist"`, `aria-pressed` when the container has `role="group"` or `mode="multi"`, and default container `role="radiogroup"` + child `role="radio"` + `aria-checked`/`aria-selected` otherwise.
     - Added `AgyToggleGroupElement.prototype.sync()` to synchronize `_value`, ARIA state attributes, and roving `tabIndex` after external `.active` class mutations.
  2. **In Hangar ([`ui/components/extensions-tab.js:124-190,284,318,446-455`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/extensions-tab.js#L124-L190))**:
     - Added `aria-label` to all 6 Settings `<agy-toggle-group>` elements and `subtab-group`, added `data-value` attributes to Settings toggle buttons, and called `g.sync?.()` after updating `.active` in `renderSettingsPane` and `renderExtensionsTab`.

### [DONE] [High] 4.2 Five `<input>` elements across Extensions lack accessible names (`aria-label`) (WCAG 1.3.1 / 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**:
  - [`ui/components/extensions-tab.js:132`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/extensions-tab.js#L132) (`[data-role="settings-ttl-input"]`)
  - [`ui/components/installed-pane.js:136`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L136) (`.ws-input`)
  - [`ui/components/marketplace-panes.js:246,325,345`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/marketplace-panes.js#L246) (`[data-role="discover-search"]`, `[data-role="local-path-input"]`, `[data-role="github-repo-input"]`)
- **Implementation Summary**:
  Added `aria-label="Custom idle timeout in minutes (1 to 240)"` (`extensions-tab.js:132`), `aria-label="Add workspace path or glob"` (`installed-pane.js:136`), `aria-label="Search sidecars and plugins"` (`marketplace-panes.js:246`), `aria-label="Local sidecar directory path"` (`marketplace-panes.js:325`), and `aria-label="GitHub repository URL or owner/repo"` (`marketplace-panes.js:345`).

### [DONE] [Medium] 4.3 "Check for updates" button (`[data-role="check-updates-btn"]`) lacks `.spinning` animation during async check
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/extensions-tab.js:368-378`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/extensions-tab.js#L368-L378)
- **Implementation Summary**:
  Added `checkBtn.classList?.add?.('spinning')` before awaiting `onCheckUpdates()` and `checkBtn.classList?.remove?.('spinning')` in the `finally` block so `.agy-icon-btn.spinning` animates the refresh icon while checking for updates.

### [DONE] [Medium] 4.4 Custom TTL input silently coerces empty or `0` input to `1` minute
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/extensions-tab.js:228-237`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/extensions-tab.js#L228-L237) (`commitTtl`)
- **Implementation Summary**:
  Guarded `commitTtl` with `const raw = Number.parseInt(ttlInput?.value, 10); if (!Number.isFinite(raw) || raw < 1) { ttlInput?.focus?.(); return; }` so blank or `<= 0` values focus the input instead of coercing to `1` minute.

---

## 5. Installed Sidecars & Plugins Panes

### [DONE] [Critical] 5.1 Duplicate nested `role="switch"` / `aria-checked` on `<button role="switch"><agy-switch>` and generic `aria-label`s across cards (WCAG 4.1.2 / 2.4.6)
- **Status**: ✅ **Completed** across `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/controls/controls.js:25-37,153-183`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.js#L25-L37) (`syncSwitchState`, `AgySwitchElement._sync`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/components/installed-pane.js:103-105,296-304`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L296-L304) (`proc-btn`, `restart-btn`, `uninstall-btn`)
    - [`ui/components/plugin-panes.js:248-251`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/plugin-panes.js#L248-L251) (`uninstall-btn`)
- **Implementation Summary**:
  1. In [`controls.js:25-37,153-183`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.js#L25-L37), set `role="presentation"` and removed `aria-checked` on `<agy-switch>` whenever it is nested inside a `<button role="switch">`, and set `role="presentation"` on the `<agy-switch>` custom element host when standalone so only the `<button role="switch">` is exposed in the accessibility tree.
  2. In [`installed-pane.js:296-304`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L296-L304) and [`plugin-panes.js:248-251`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/plugin-panes.js#L248-L251), assigned card-specific `title` and `aria-label` attributes (`Enable or disable ${scLabel}`, `Restart ${scLabel}`, `Uninstall ${scLabel}`, `Uninstall ${p.name}`).

### [DONE] [High] 5.2 Workspace Scope buttons (`Global (*)` / `+ Workspace`) in `<agy-toggle-group>` lack multi-toggle `aria-pressed` support (WCAG 4.1.2)
- **Status**: ✅ **Completed** across `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/tabs/toggle-group.js:22-45,200-285`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/toggle-group.js#L22-L45) (`isMultiToggleContainer`, `syncToggleItemAria`, `AgyToggleGroupElement`)
  - **Hangar (`antigravity-sidecar-hub`)**: [`ui/components/installed-pane.js:128-131,333-351`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L128-L131)
- **Implementation Summary**:
  1. Added `role="group"` / `mode="multi"` support in [`toggle-group.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/toggle-group.js#L22-L45) so child `.agy-toggle-item` buttons expose `aria-pressed="true|false"` (without `aria-selected` or `aria-checked`) while maintaining arrow-key roving focus.
  2. Added `role="group" aria-label="Workspace Scope"` to `<agy-toggle-group>` in [`installed-pane.js:128`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L128) and synced `aria-pressed` + `sync()` on `global-btn` and `add-ws-btn` (`lines 333-351`).

### [DONE] [High] 5.3 `Restart`, `Auto-Sleep`, and `Workspace Scope` actions lack pending/disabled states during async RPCs
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/installed-pane.js:36-60,150-221`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L36-L60) (`runCardAction`)
- **Implementation Summary**:
  Updated `runCardAction(card, action, triggerBtn = null, spin = false)` to guard `card._busy`, disable `triggerBtn` during async RPCs, and toggle `.spinning` on `restart-btn` (`spin = true`).

### [DONE] [Medium] 5.4 `.ws-rule-remove` hit target is `20×20px` (below WCAG 2.2 AA `24×24px` minimum)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components.css:279-292`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L279-L292) (`.ws-rule-remove`)
- **Implementation Summary**:
  Updated `.ws-rule-remove` dimensions from `width: 20px; height: 20px;` to `width: 24px; height: 24px;` to meet WCAG 2.2 AA `2.5.8 Target Size (Minimum)` and match native `.agy-icon-btn` dimensions.

### [DONE] [Medium] 5.5 Destructive `Uninstall` confirmation button uses `.agy-btn-primary` (blue) instead of `.agy-btn-danger` (red) and lacks focus management
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**:
  - [`ui/components/installed-pane.js:123-129,246-263`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js#L123-L129)
  - [`ui/components/plugin-panes.js:152-158,184-200`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/plugin-panes.js#L152-L158)
- **Implementation Summary**:
  Changed `[data-role="uninstall-confirm-btn"]` class to `agy-btn agy-btn-danger` in both `installed-pane.js` and `plugin-panes.js`, focused `[data-role="uninstall-cancel"]` when opening the uninstall confirmation bar, and restored focus to `[data-role="uninstall-btn"]` on cancel.

---

## 6. Marketplace (Discover & Sideload) Panes
**File**: [`ui/components/marketplace-panes.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/marketplace-panes.js)

### [DONE] [Medium] 6.1 Discover search/category filter shows a blank container when 0 packages match
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/marketplace-panes.js:138-246`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/marketplace-panes.js#L138-L246) (`reconcileDiscoverList`)
- **Implementation Summary**:
  Rendered `<div class="agy-empty-state" role="status" data-role="discover-empty">` inside `[data-role="discover-list"]` when `filtered.length === 0` (and removed it when packages match).

### [DONE] [Medium] 6.2 Sideload `Validate`, `Link Folder`, and `Install` buttons lack disabled/pending states and `[data-role="sideload-banner"]` lacks `role="status"`
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/marketplace-panes.js:321,378-460`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/marketplace-panes.js#L321)
- **Implementation Summary**:
  Added `role="status" aria-live="polite"` to `[data-role="sideload-banner"]`, guarded `runSideload` with `shell._busy` and disabled `[validate-btn, link-btn, github-install-btn, gh-consent-confirm]` while running, and bound `Enter` keydown handlers on `local-path-input` and `github-repo-input`.

---

## 7. Interactive Terminal, Direct VT100 Emulator, Selection Quote & Mini-Composer

### [DONE] [High] 7.1 Direct VT100 terminal screen lacks accessible role/label and `.term-toolbar-actions` buttons lack `aria-label` / `aria-pressed` (WCAG 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**:
  - [`ui/components/terminal-emulator.js:93-105`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-emulator.js#L93-L105) (`createTerminalEmulator`)
  - [`ui/components/terminal-tab.js:31-48,217-225`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-tab.js#L31-L48) (`[data-action="split"]`, `[data-action="popout"]`)
  - [`ui/components/terminal-pane.js:143-155`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L143-L155) (`[data-role="pane-close"]`)
- **Implementation Summary**:
  1. Added `role="log"` and `aria-label="Terminal output"` to `.term-screen` in [`terminal-emulator.js:95-96`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-emulator.js#L95-L96).
  2. Added `aria-label` and `aria-pressed` to `splitBtn` (`"Split Terminal"`) and `popoutBtn` (`"Merge back into main Terminal tab"` / `"Pin Terminal Tab to Top Bar"`) in [`terminal-tab.js:31-48`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-tab.js#L31-L48) and synchronized `aria-pressed` on both buttons in `renderToolbar()` ([`terminal-tab.js:217-225`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-tab.js#L217-L225)).
  3. Added `aria-label="Close Split Pane"` to `[data-role="pane-close"]` and `aria-hidden="true"` to `[data-role="pane-dot"]` in [`terminal-pane.js:143-155`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L143-L155).

### [DONE] [High] 7.2 Inline Mini-Composer (`.term-mini-composer`) lacks dialog semantics, unlabeled buttons/textarea, and focus restoration on close (WCAG 2.4.3 / 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/terminal-quote.js:278-460`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-quote.js#L278-L460) (`openTerminalMiniComposer`)
- **Implementation Summary**:
  1. Added `role="dialog"` and `aria-label="Ask about terminal output"` to `.term-mini-composer`.
  2. Added `aria-label="Cancel (Esc)"` on `closeBtn`, `aria-label="Ask about terminal output"` on `input`, and `aria-label="Choose Side Chat thread"` on `sideChatPickBtn`.
  3. Captured `mini._prevFocus` on open and restored `mini._prevFocus?.focus?.()` in `hide()` when dismissing via `Escape`, the close button, or after sending to Main Chat (while suppressing focus steal when transitioning directly into the Side Chat drawer).

### [DONE] [Medium] 7.3 `AgyUI.showToast` and `showTerminalQuoteToast` lack ARIA live-region roles, error styling on failed Main Chat send, and keyboard shortcut for `Quote & Ask` (WCAG 2.1.1 / 4.1.3)
- **Status**: ✅ **Completed** across `antigravity-sidecar-kit` and `antigravity-sidecar-hub`.
- **Location**:
  - **Upstream (`antigravity-sidecar-kit`)**: [`lib/ui/overlays/overlays.js:161-175`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.js#L161-L175) (`ui.showToast`)
  - **Hangar (`antigravity-sidecar-hub`)**:
    - [`ui/components/terminal-quote.js:168-185,540-551`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-quote.js#L168-L185) (`showTerminalQuoteToast`, `askBtn`)
    - [`ui/components/sidechat-store.js:86-89`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-store.js#L86-L89) (`_submitQuoteToMain`)
    - [`ui/components/terminal-emulator.js:400-407`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-emulator.js#L400-L407), [`ui/components/terminal-pane.js:188`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L188), & [`ui/jetbox/jetbox-bootstrap.js:1292-1298,1517-1527`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/jetbox/jetbox-bootstrap.js#L1517-L1527)
- **Implementation Summary**:
  1. Updated `ui.showToast` in [`overlays.js:161-175`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.js#L161-L175) and `showTerminalQuoteToast` in [`terminal-quote.js:168-185`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-quote.js#L168-L185) to set `role="status"` / `aria-live="polite"` on standard toasts and `.error` + `role="alert"` / `aria-live="assertive"` on error toasts.
  2. Updated `_submitQuoteToMain` in [`sidechat-store.js:88`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-store.js#L88) to pass `isError = true` to `showTerminalQuoteToast` when sending to Main Chat fails.
  3. Bound `Alt+Shift+L` (`⇧⌘L` on macOS) to trigger `Quote & Ask` in both the VT100 emulator ([`terminal-emulator.js:405`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-emulator.js#L405), [`terminal-pane.js:188`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js#L188)) and Jetbox terminal iframe ([`jetbox-bootstrap.js:1525`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/jetbox/jetbox-bootstrap.js#L1525)), and added `aria-keyshortcuts` to the `Quote & Ask` button.

### [DONE] [Medium] 7.4 Toast positioning (`top: 36px; right: 12px`) overlaps split-pane headers
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components.css:1028-1047`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L1028-L1047) (`:is(.term-shell > .agy-toast, .term-quote-toast)`)
- **Implementation Summary**:
  1. Updated `:is(.term-shell > .agy-toast, .term-quote-toast)` in [`ui/components.css:1028-1042`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L1028-L1042) to `top: auto; bottom: 12px;`, matching upstream `overlays.css:76-78` so toasts anchor to the bottom-right of `.term-shell` without overlapping the right-hand `.term-pane-header` and its `.term-pane-close` button.
  2. Added `:is(.term-shell > .agy-toast, .term-quote-toast).error` (`border-color: var(--agy-bad, var(--hub-danger)); color: var(--agy-bad, var(--hub-danger));`) so `.term-shell > .agy-toast`'s `(0, 2, 0)` specificity does not override `.agy-toast.error` styling.

### [DONE] [Low] 7.5 Undersized `.term-pane-close` button (`16×16px`) and hardcoded `#4ade80` fallback in `.term-pane-dot.active`
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components.css:392-406,552-557`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L392-L406)
- **Implementation Summary**:
  Expanded `.term-pane-close` hit target to `width: 20px; height: 20px;` and replaced hardcoded `#4ade80` fallback in `.term-pane-dot.active` with `var(--status-ok-dot, var(--agy-ok))`.

---

## 8. Docked Side-Chat Pane
**Files**: [`ui/components/sidechat-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js), [`ui/components.css`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css)

### [DONE] [High] 8.1 Unlabeled controls and missing `aria-expanded` / `aria-pressed` states in Side-Chat toolbar & "Send to Main Chat" bar (WCAG 4.1.2)
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components/sidechat-pane.js:124-365,442-470`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js#L124-L365), [`ui/components/sidechat-strip.js:370-375`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-strip.js#L370-L375)
- **Implementation Summary**:
  Added `aria-label` to `threadSelect`, `input`, `newThreadBtn`, `deleteBtn`, `overviewBtn`, `popoutBtn`, `dockBtn`, and `closeBtn`, and synchronized `aria-expanded` on `mainToggleBtn` and `aria-pressed` on `overviewBtn` and `popoutBtn`.

### [DONE] [Low] 8.2 Redundant split-height CSS rules for `.term-quote-composer[data-slot="top"]`
- **Status**: ✅ **Completed** in `antigravity-sidecar-hub`.
- **Location**: [`ui/components.css:720-726`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css#L720-L726), [`ui/styles.css:154-173`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/styles.css#L154-L173)
- **Implementation Summary**:
  Removed the duplicate `.term-quote-composer[data-slot="top"]`, `.main-viewport.is-split > .term-quote-composer[data-slot="top"]`, and `.term-quote-composer[data-slot="bottom"]` rules from `ui/components.css` so `.slot-top` / `.slot-bottom` in `ui/styles.css` remain the single source of truth.

---

## Execution Order

1. **Phase 1 — Upstream [`antigravity-sidecar-kit`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit) Fixes & Tests**:
   - ✅ **Completed (100% — Findings 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 2.8, 4.1, 5.1, 5.2, 7.3 + NewUX Button Parity)**: [`theme.mjs`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/theme.mjs), [`shell.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/shell.css), [`theme-client.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/theme-client.js), [`sync-client.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/shell/sync-client.js), [`surfaces.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/surfaces/surfaces.css), [`tab-pill.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-pill.js), [`tab-strip.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tab-strip.js), [`toggle-group.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/toggle-group.js), [`controls.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.js), [`tab-drag.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tab-drag/tab-drag.js), [`layout.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/layout/layout.js), [`overlays.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.js), [`tabs.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/tabs/tabs.css), [`controls.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/controls/controls.css), [`overlays.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/overlays/overlays.css), [`layout.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-sidecar-kit/lib/ui/layout/layout.js).
2. **Phase 2 — Hangar ([`antigravity-sidecar-hub`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub)) & Context Monitor ([`antigravity-context-monitor`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor)) Fixes & Tests**:
   - ✅ **Completed (100% — All Findings 1.1–8.2 + NewUX `+` Button + Context Monitor Collapsible Drawers)**: [`lib/jetbox-proxy.mjs`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/lib/jetbox-proxy.mjs), [`ui/index.html`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/index.html), [`ui/styles.css`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/styles.css), [`ui/components.css`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components.css), [`ui/core.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/core.js), [`ui/app.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/app.js), [`ui/jetbox/jetbox-bootstrap.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/jetbox/jetbox-bootstrap.js), [`ui/components/tab-bar.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/tab-bar.js), [`ui/components/iframe-deck.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/iframe-deck.js), [`ui/components/extensions-tab.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/extensions-tab.js), [`ui/components/installed-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/installed-pane.js), [`ui/components/plugin-panes.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/plugin-panes.js), [`ui/components/marketplace-panes.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/marketplace-panes.js), [`ui/components/sidechat-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-pane.js), [`ui/components/sidechat-strip.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/sidechat-strip.js), [`ui/components/terminal-pane.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-pane.js), [`ui/components/terminal-tab.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-tab.js), [`ui/components/terminal-drag.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-drag.js), [`ui/components/terminal-groups.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-groups.js), [`ui/components/terminal-quote.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-quote.js), [`ui/components/terminal-emulator.js`](file:///c:/Users/arthu/IdeaProjects/antigravity-sidecar-hub/ui/components/terminal-emulator.js), and Context Monitor [`ui/app.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/app.js), [`ui/styles.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/styles.css), [`ui/components.css`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components.css), [`ui/components/context-drawers.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components/context-drawers.js), [`ui/components/subagent-drawer.js`](file:///C:/Users/arthu/IdeaProjects/antigravity-context-monitor/ui/components/subagent-drawer.js).
