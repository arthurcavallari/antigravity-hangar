/** @fileoverview Self-contained VT100/ANSI interactive terminal emulator for Hangar Direct Engine mode. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const ANSI_16 = ['#1e1e1e', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

  function color256(rawN) {
    const n = Math.max(0, Math.min(255, Number.isFinite(rawN) ? rawN : 0));
    if (n < 16) return ANSI_16[n] || '';
    if (n < 232) { const idx = n - 16, v = (c) => (c === 0 ? 0 : 55 + c * 40); return `rgb(${v(Math.floor(idx / 36))},${v(Math.floor((idx % 36) / 6))},${v(idx % 6)})`; }
    const gray = 8 + (n - 232) * 10; return `rgb(${gray},${gray},${gray})`;
  }
  const clamp255 = (v) => Math.max(0, Math.min(255, Number.isFinite(v) ? v : 0));
  const blankCell = () => ({ ch: ' ', fg: '', bg: '', b: 0, d: 0, i: 0, u: 0, v: 0 });
  const makeRow = (cols) => Array.from({ length: cols }, blankCell);
  const isRowBlank = (row) => row.every((c) => c.ch === ' ' && !c.bg && !c.v);
  const KEY_MAP = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Insert: '\x1b[2~' };

  function mapKeyToAnsi(e) {
    if (e.altKey && (e.key === 'l' || e.key === 'L')) return null;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'v') return null;
      if (k.length === 1 && k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) - 96);
    }
    return KEY_MAP[e.key] || (e.key.length === 1 && !e.ctrlKey && !e.metaKey ? (e.altKey ? `\x1b${e.key}` : e.key) : null);
  }

  ns.createTerminalEmulator = function createTerminalEmulator(containerEl, { onInput, onResize, onTitleChange, onSelectionChange, onQuoteShortcut } = {}) {
    let cols = 96, rows = 26, scrollback = [], grid = Array.from({ length: rows }, () => makeRow(cols));
    let altGrid = null, altCx = 0, altCy = 0, inAlt = false, cx = 0, cy = 0, savedX = 0, savedY = 0, cursorVisible = true, bracketedPaste = false;
    let style = { fg: '', bg: '', b: 0, d: 0, i: 0, u: 0, v: 0 }, pState = 'normal', pBuf = '', rafId = 0, resizeTimer = 0, disposed = false, stickBottom = true;
    const rowEls = [];

    containerEl.tabIndex = -1;
    const viewport = document.createElement('div'), screen = document.createElement('div'), inputSink = document.createElement('textarea');
    viewport.className = 'term-viewport'; screen.className = 'term-screen'; inputSink.className = 'term-input-sink';
    inputSink.setAttribute('aria-label', 'Terminal input'); inputSink.spellcheck = false; inputSink.autocapitalize = 'off'; inputSink.autocomplete = 'off';
    viewport.appendChild(screen); containerEl.append(viewport, inputSink);
    viewport.addEventListener('scroll', () => { stickBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 18; }, { passive: true });

    const scrollUp = (n = 1) => {
      for (let i = 0; i < n; i++) {
        const top = grid.shift();
        if (!inAlt && top && (!isRowBlank(top) || (scrollback.length > 0 && !grid.every(isRowBlank)))) { scrollback.push(top); if (scrollback.length > 1000) scrollback.shift(); }
        grid.push(makeRow(cols));
      }
    };
    const scrollDown = (n = 1) => { for (let i = 0; i < n; i++) { grid.pop(); grid.unshift(makeRow(cols)); } };
    const ensureRowCapacity = (target1Based) => { while (grid.length < Math.min(120, Math.max(rows, target1Based))) grid.push(makeRow(cols)); rows = grid.length; };

    function applySgr(params) {
      const nums = params === '' ? [0] : params.split(';').map((x) => parseInt(x || '0', 10));
      for (let i = 0; i < nums.length; i++) {
        const c = nums[i];
        if (c === 0) style = { fg: '', bg: '', b: 0, d: 0, i: 0, u: 0, v: 0 };
        else if (c === 1) style.b = 1; else if (c === 2) style.d = 1; else if (c === 3) style.i = 1;
        else if (c === 4) style.u = 1; else if (c === 7) style.v = 1;
        else if (c === 22) { style.b = 0; style.d = 0; } else if (c === 23) style.i = 0;
        else if (c === 24) style.u = 0; else if (c === 27) style.v = 0;
        else if (c >= 30 && c <= 37) style.fg = ANSI_16[c - 30]; else if (c === 39) style.fg = '';
        else if (c >= 40 && c <= 47) style.bg = ANSI_16[c - 40]; else if (c === 49) style.bg = '';
        else if (c >= 90 && c <= 97) style.fg = ANSI_16[c - 90 + 8];
        else if (c >= 100 && c <= 107) style.bg = ANSI_16[c - 100 + 8];
        else if (c === 38 || c === 48) {
          const isFg = c === 38;
          if (nums[i + 1] === 5 && nums[i + 2] !== undefined) {
            if (isFg) style.fg = color256(nums[i + 2]); else style.bg = color256(nums[i + 2]);
            i += 2;
          } else if (nums[i + 1] === 2 && nums[i + 4] !== undefined) {
            const rgb = `rgb(${clamp255(nums[i + 2])},${clamp255(nums[i + 3])},${clamp255(nums[i + 4])})`;
            if (isFg) style.fg = rgb; else style.bg = rgb;
            i += 4;
          }
        }
      }
    }

    function handleCsi(raw, finalChar) {
      if (/^[>=<]/.test(raw) || /[ !"#$%&'()*+,-./]/.test(raw)) return;
      const priv = raw.startsWith('?'), clean = priv ? raw.slice(1) : raw;
      const parts = clean ? clean.split(';').map((n) => parseInt(n || '0', 10)) : [];
      const p1 = parts[0] || 1, p2 = parts[1] || 1, p0 = parts[0] || 0;
      if (priv) {
        const set = finalChar === 'h';
        for (const mode of parts) {
          if (mode === 25) cursorVisible = set;
          else if (mode === 2004) bracketedPaste = set;
          else if (mode === 1049 || mode === 47) {
            if (set && !inAlt) { altGrid = grid; altCx = cx; altCy = cy; inAlt = true; grid = Array.from({ length: rows }, () => makeRow(cols)); cx = 0; cy = 0; }
            else if (!set && inAlt) { grid = altGrid || grid; cx = altCx; cy = altCy; inAlt = false; altGrid = null; }
          }
        }
        return;
      }
      switch (finalChar) {
        case 'A': cy = Math.max(0, cy - p1); break;
        case 'B': cy = Math.min(rows - 1, cy + p1); break;
        case 'C': cx = Math.min(cols - 1, cx + p1); break;
        case 'D': cx = Math.max(0, cx - p1); break;
        case 'E': cy = Math.min(rows - 1, cy + p1); cx = 0; break;
        case 'F': cy = Math.max(0, cy - p1); cx = 0; break;
        case 'G': cx = Math.min(cols - 1, Math.max(0, p1 - 1)); break;
        case 'd': ensureRowCapacity(p1); cy = Math.min(rows - 1, Math.max(0, p1 - 1)); break;
        case 'H': case 'f': ensureRowCapacity(p1); cy = Math.min(rows - 1, Math.max(0, p1 - 1)); cx = Math.min(cols - 1, Math.max(0, p2 - 1)); break;
        case 'J':
          if (p0 === 2 || p0 === 3) { scrollback = []; grid = Array.from({ length: rows }, () => makeRow(cols)); }
          else if (p0 === 0) { for (let x = cx; x < cols; x++) grid[cy][x] = blankCell(); for (let y = cy + 1; y < rows; y++) grid[y] = makeRow(cols); }
          else if (p0 === 1) { for (let y = 0; y < cy; y++) grid[y] = makeRow(cols); for (let x = 0; x <= cx; x++) grid[cy][x] = blankCell(); }
          break;
        case 'K':
          if (p0 === 0) for (let x = cx; x < cols; x++) grid[cy][x] = blankCell();
          else if (p0 === 1) for (let x = 0; x <= cx; x++) grid[cy][x] = blankCell();
          else if (p0 === 2) grid[cy] = makeRow(cols);
          break;
        case 'X': for (let x = cx; x < Math.min(cols, cx + p1); x++) grid[cy][x] = blankCell(); break;
        case 'P': grid[cy].splice(cx, p1); while (grid[cy].length < cols) grid[cy].push(blankCell()); break;
        case '@': for (let i = 0; i < p1; i++) grid[cy].splice(cx, 0, blankCell()); grid[cy].length = cols; break;
        case 'L': for (let i = 0; i < p1; i++) { grid.pop(); grid.splice(cy, 0, makeRow(cols)); } break;
        case 'M': for (let i = 0; i < p1; i++) { grid.splice(cy, 1); grid.push(makeRow(cols)); } break;
        case 'S': scrollUp(p1); break;
        case 'T': scrollDown(p1); break;
        case 's': savedX = cx; savedY = cy; break;
        case 'u': cx = savedX; cy = savedY; break;
        case 'm': applySgr(clean); break;
      }
    }

    function putChar(ch) {
      if (cx >= cols) { cx = 0; cy += 1; if (cy >= rows) { cy = rows - 1; scrollUp(1); } }
      grid[cy][cx] = { ch, ...style }; cx += 1;
    }

    function write(data, { reset = false } = {}) {
      if (reset) {
        scrollback = []; grid = Array.from({ length: rows }, () => makeRow(cols));
        cx = 0; cy = 0; pState = 'normal'; pBuf = ''; style = { fg: '', bg: '', b: 0, d: 0, i: 0, u: 0, v: 0 };
      }
      const str = String(data || '').replace(/\x1b\[H(?:\r?\n)+\x1b\[H/g, '\x1b[H').replace(/(?:\x1b\[K\r?\n)+(?:\x1b\[K)?(?=(?:\x1b\[\?25[lh]|\x1b\[m)*\x1b\[(?:\d+;\d+)?H)/g, '\x1b[J');
      for (let i = 0; i < str.length; i++) {
        const ch = str[i], code = ch.charCodeAt(0);
        if (pState === 'normal') {
          if (ch === '\x1b') pState = 'esc';
          else if (ch === '\r') cx = 0;
          else if (ch === '\n') { cy += 1; if (cy >= rows) { cy = rows - 1; scrollUp(1); } }
          else if (ch === '\b' || code === 8) cx = Math.max(0, cx - 1);
          else if (ch === '\t') cx = Math.min(cols - 1, (Math.floor(cx / 8) + 1) * 8);
          else if (code >= 32) putChar(ch);
        } else if (pState === 'esc') {
          if (ch === '[') { pState = 'csi'; pBuf = ''; }
          else if (ch === ']') { pState = 'osc'; pBuf = ''; }
          else if (ch === '7') { savedX = cx; savedY = cy; pState = 'normal'; }
          else if (ch === '8') { cx = savedX; cy = savedY; pState = 'normal'; }
          else if (ch === 'c') { grid = Array.from({ length: rows }, () => makeRow(cols)); cx = 0; cy = 0; pState = 'normal'; }
          else pState = 'normal';
        } else if (pState === 'csi') {
          if (code >= 0x40 && code <= 0x7e) { handleCsi(pBuf, ch); pState = 'normal'; }
          else if (pBuf.length > 4096) pState = 'normal'; else pBuf += ch;
        } else if (pState === 'osc') {
          if (ch === '\x07' || (ch === '\\' && pBuf.endsWith('\x1b'))) {
            const rawOsc = ch === '\\' ? pBuf.slice(0, -1) : pBuf, semi = rawOsc.indexOf(';');
            if (semi !== -1 && (rawOsc.startsWith('0;') || rawOsc.startsWith('2;'))) onTitleChange?.(rawOsc.slice(semi + 1));
            pState = 'normal';
          } else if (pBuf.length > 4096) pState = 'normal'; else pBuf += ch;
        }
      }
      scheduleRender();
    }

    function renderRowHtml(row, isCursorRow) {
      let end = row.length - 1;
      while (end >= 0 && row[end].ch === ' ' && !row[end].bg && !row[end].v && !(isCursorRow && end === cx)) end--;
      if (isCursorRow && cx > end) end = Math.min(row.length - 1, cx);
      if (end < 0) return ' ';
      let html = '';
      for (let x = 0; x <= end; x++) {
        const c = row[x], isCur = isCursorRow && cursorVisible && x === cx;
        const fg = c.v ? (c.bg || 'var(--hub-bg)') : c.fg, bg = c.v ? (c.fg || 'var(--hub-fg)') : c.bg, ch = ns.escHtml(c.ch || ' ');
        if (!fg && !bg && !c.b && !c.d && !c.i && !c.u && !isCur) html += ch;
        else {
          const st = [];
          if (fg) st.push(`color:${fg}`); if (bg) st.push(`background:${bg}`);
          if (c.b) st.push('font-weight:700'); if (c.d) st.push('opacity:0.65');
          if (c.i) st.push('font-style:italic'); if (c.u) st.push('text-decoration:underline');
          html += `<span${isCur ? ' class="term-cursor"' : ''}${st.length ? ` style="${st.join(';')}"` : ''}>${ch}</span>`;
        }
      }
      return html;
    }

    const getSelectionText = () => {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed) return '';
      if (!viewport.contains(sel.anchorNode) && !viewport.contains(sel.focusNode)) return '';
      return sel.toString();
    };

    function flushRender() {
      rafId = 0;
      if (disposed || getSelectionText()) return;
      let lastGridIdx = Math.min(grid.length - 1, cy);
      for (let r = grid.length - 1; r > lastGridIdx; r--) { if (!isRowBlank(grid[r])) { lastGridIdx = r; break; } }
      const allRows = [...scrollback, ...grid.slice(0, lastGridIdx + 1)], cursorRowIdx = scrollback.length + cy;
      while (rowEls.length > allRows.length) rowEls.pop()?.remove?.();
      for (let r = 0; r < allRows.length; r++) {
        const html = renderRowHtml(allRows[r], r === cursorRowIdx);
        let div = rowEls[r];
        if (!div) {
          div = document.createElement('div');
          div.className = 'term-row'; div._h = html; div.innerHTML = html;
          rowEls.push(div); screen.appendChild(div);
        } else if (div._h !== html) { div._h = html; div.innerHTML = html; }
      }
      screen._rows = rowEls;
      if (stickBottom) viewport.scrollTop = viewport.scrollHeight;
    }

    function scheduleRender() { if (!rafId && !disposed) { rafId = -1; const id = requestAnimationFrame(flushRender); if (rafId === -1) rafId = id; } }

    function handleKeyDown(e) {
      const selText = getSelectionText();
      if ((e.altKey && (e.key === 'l' || e.key === 'L')) || ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L') && selText)) {
        if (selText) { e.preventDefault(); e.stopPropagation(); onQuoteShortcut?.(selText); return; }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && selText) {
        navigator.clipboard?.writeText(selText).catch(() => {});
        window.getSelection?.()?.removeAllRanges(); onSelectionChange?.(null); scheduleRender(); e.preventDefault(); return;
      }
      const seq = mapKeyToAnsi(e);
      if (seq !== null) {
        e.preventDefault();
        if (selText) { window.getSelection?.()?.removeAllRanges(); onSelectionChange?.(null); scheduleRender(); }
        stickBottom = true; onInput?.(seq);
      }
    }

    const setFocusState = (foc) => containerEl.classList?.toggle('is-input-focused', Boolean(foc && !disposed));
    const onWinBlur = () => setFocusState(false), onWinFocus = () => setFocusState(document.activeElement === inputSink);
    inputSink.addEventListener('focus', () => setFocusState(true));
    inputSink.addEventListener('blur', () => setFocusState(false));
    window.addEventListener?.('blur', onWinBlur); window.addEventListener?.('focus', onWinFocus);
    inputSink.addEventListener('keydown', handleKeyDown);
    containerEl.addEventListener('keydown', (e) => { if (e.target !== inputSink) { inputSink.focus({ preventScroll: true }); setFocusState(true); handleKeyDown(e); } });
    inputSink.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) { e.preventDefault(); stickBottom = true; onInput?.(bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text); }
    });

    let downPos = null;
    containerEl.addEventListener('mousedown', (e) => { if (!e.target?.closest?.('.term-quote-popup, .term-pane-header')) downPos = { x: e.clientX || 0, y: e.clientY || 0 }; });
    const onWinMouseUp = (e) => {
      if (!downPos || disposed) return;
      const moved = Math.hypot((e.clientX || 0) - downPos.x, (e.clientY || 0) - downPos.y); downPos = null;
      setTimeout(() => {
        if (disposed) return;
        const text = moved >= 4 ? getSelectionText() : '';
        if (text) onSelectionChange?.({ text, clientX: e.clientX, clientY: e.clientY });
        else { window.getSelection?.()?.removeAllRanges(); onSelectionChange?.(null); inputSink.focus({ preventScroll: true }); setFocusState(true); scheduleRender(); }
      }, 0);
    };
    window.addEventListener?.('mouseup', onWinMouseUp);

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const rect = viewport.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 30) return;
      const nextCols = Math.max(24, Math.min(240, Math.floor((rect.width - 24) / 7.6)));
      const nextRows = Math.max(6, Math.min(120, Math.floor((rect.height - 16) / 17)));
      if (nextCols !== cols || nextRows !== rows) {
        while (grid.length > nextRows && isRowBlank(grid.at(-1))) grid.pop();
        while (grid.length > nextRows) {
          const top = grid.shift();
          if (!inAlt && top && !isRowBlank(top)) scrollback.push(top);
          cy = Math.max(0, cy - 1);
        }
        while (grid.length < nextRows && !inAlt && scrollback.length > 0) { grid.unshift(scrollback.pop()); cy += 1; }
        while (grid.length < nextRows) grid.push(makeRow(nextCols));
        for (const r of grid) { while (r.length < nextCols) r.push(blankCell()); if (r.length > nextCols) r.length = nextCols; }
        cols = nextCols; rows = nextRows; cx = Math.min(cx, cols - 1); cy = Math.min(cy, rows - 1);
        scheduleRender(); clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (!disposed) onResize?.(cols, rows); }, 60);
      }
    }) : null;
    ro?.observe(viewport);

    return {
      write, flush: flushRender,
      focus: () => { inputSink.focus({ preventScroll: true }); setFocusState(true); },
      getSelection: getSelectionText,
      clearSelection: () => { window.getSelection?.()?.removeAllRanges(); onSelectionChange?.(null); scheduleRender(); },
      getDimensions: () => ({ cols, rows }),
      dispose: () => {
        disposed = true; clearTimeout(resizeTimer); if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener?.('mouseup', onWinMouseUp); window.removeEventListener?.('blur', onWinBlur); window.removeEventListener?.('focus', onWinFocus); ro?.disconnect();
      },
    };
  };
})();
