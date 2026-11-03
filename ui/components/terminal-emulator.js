/** @fileoverview Self-contained VT100/ANSI interactive terminal emulator for Hangar Direct Engine mode. */
(function () {
  const ns = (window.Hangar = window.Hangar || {});
  const ANSI_16 = ['#1e1e1e', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
  const KEY_MAP = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~', Insert: '\x1b[2~' };
  const SGR_MAP = { 1: ['b', 1], 2: ['d', 1], 3: ['i', 1], 4: ['u', 1], 7: ['v', 1], 23: ['i', 0], 24: ['u', 0], 27: ['v', 0], 39: ['fg', ''], 49: ['bg', ''] };
  const clamp255 = (v) => Math.max(0, Math.min(255, Number.isFinite(v) ? v : 0));
  const blankStyle = () => ({ fg: '', bg: '', b: 0, d: 0, i: 0, u: 0, v: 0 }), isRowBlank = (row) => row.every((c) => c.ch === ' ' && !c.bg && !c.v);
  const blankCell = () => ({ ch: ' ', ...blankStyle() }), makeRow = (cols) => Array.from({ length: cols }, blankCell);
  function color256(rawN) {
    const n = clamp255(rawN), v = (c) => (c === 0 ? 0 : 55 + c * 40);
    if (n < 16) return ANSI_16[n] || '';
    if (n >= 232) return `rgb(${8 + (n - 232) * 10},${8 + (n - 232) * 10},${8 + (n - 232) * 10})`;
    return `rgb(${v(Math.floor((n - 16) / 36))},${v(Math.floor(((n - 16) % 36) / 6))},${v((n - 16) % 6)})`;
  }
  function mapKeyToAnsi(e) {
    if (e.altKey && (e.key === 'l' || e.key === 'L')) return null;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) return k === 'v' ? null : (k.length === 1 && k >= 'a' && k <= 'z' ? String.fromCharCode(k.charCodeAt(0) - 96) : null);
    return KEY_MAP[e.key] || (e.key.length === 1 && !e.ctrlKey && !e.metaKey ? (e.altKey ? `\x1b${e.key}` : e.key) : null);
  }
  ns.createTerminalEmulator = function createTerminalEmulator(containerEl, { onInput, onResize, onTitleChange, onSelectionChange, onQuoteShortcut } = {}) {
    let cols = 96, rows = 26, scrollback = [], altState = null, cx = 0, cy = 0, savedPos = [0, 0], cursorVisible = true, bracketedPaste = false, style = blankStyle(), pState = 'normal', pBuf = '', rafId = 0, resizeTimer = 0, disposed = false, stickBottom = true, downPos = null;
    let grid = Array.from({ length: rows }, () => makeRow(cols)), rowEls = [];
    containerEl.tabIndex = -1;
    const viewport = Object.assign(document.createElement('div'), { className: 'term-viewport' }), screen = Object.assign(document.createElement('div'), { className: 'term-screen' }), inputSink = Object.assign(document.createElement('textarea'), { className: 'term-input-sink', spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
    inputSink.setAttribute('aria-label', 'Terminal input');
    viewport.appendChild(screen);
    containerEl.append(viewport, inputSink);
    viewport.addEventListener('scroll', () => { stickBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 18; }, { passive: true });
    const scrollUp = (n = 1) => {
      for (let i = 0; i < n; i++) {
        const top = grid.shift();
        if (!altState && top && (!isRowBlank(top) || (scrollback.length > 0 && !grid.every(isRowBlank))) && scrollback.push(top) > 1000) scrollback.shift();
        grid.push(makeRow(cols));
      }
    };
    const scrollDown = (n = 1) => grid.splice(0, rows, ...Array.from({ length: n }, () => makeRow(cols)), ...grid.slice(0, Math.max(0, rows - n)));
    const lineFeed = () => (++cy >= rows ? void scrollUp(1, (cy = rows - 1)) : undefined);
    function applySgr(params) {
      const nums = params === '' ? [0] : params.split(';').map((x) => parseInt(x || '0', 10));
      for (let i = 0; i < nums.length; i++) {
        const c = nums[i];
        if (c === 0) style = blankStyle();
        else if (c === 22) Object.assign(style, { b: 0, d: 0 });
        else if (SGR_MAP[c]) style[SGR_MAP[c][0]] = SGR_MAP[c][1];
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) style.fg = ANSI_16[c >= 90 ? c - 82 : c - 30];
        else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) style.bg = ANSI_16[c >= 100 ? c - 92 : c - 40];
        else if ((c === 38 || c === 48) && (nums[i + 1] === 5 || nums[i + 1] === 2) && nums[i + (nums[i + 1] === 5 ? 2 : 4)] !== undefined) {
          style[c === 38 ? 'fg' : 'bg'] = nums[i + 1] === 5 ? color256(nums[i + 2]) : `rgb(${clamp255(nums[i + 2])},${clamp255(nums[i + 3])},${clamp255(nums[i + 4])})`;
          i += nums[i + 1] === 5 ? 2 : 4;
        }
      }
    }
    function handleCsi(raw, finalChar) {
      if (/^[>=<]/.test(raw) || /[ !"#$%&'()*+,-./]/.test(raw)) return;
      const priv = raw.startsWith('?'), clean = priv ? raw.slice(1) : raw, parts = clean ? clean.split(';').map((n) => parseInt(n || '0', 10)) : [];
      const p0 = parts[0] || 0, p1 = parts[0] || 1, p2 = parts[1] || 1, set = finalChar === 'h';
      if (priv) {
        for (const mode of parts) {
          if (mode === 25) cursorVisible = set;
          else if (mode === 2004) bracketedPaste = set;
          else if ((mode === 1049 || mode === 47) && set && !altState && (altState = { grid, cx, cy })) grid = Array.from({ length: rows }, () => makeRow(cols), (cx = (cy = 0)));
          else if ((mode === 1049 || mode === 47) && !set && altState) ({ grid, cx, cy, altState = null } = altState);
        }
        return;
      }
      if (finalChar === 'A' || finalChar === 'F' || finalChar === 'B' || finalChar === 'E') cy = Math.max(0, Math.min(rows - 1, cy + ((finalChar === 'A' || finalChar === 'F') ? -p1 : p1)));
      if (finalChar === 'E' || finalChar === 'F') cx = 0;
      else if (finalChar === 'C' || finalChar === 'D') cx = Math.max(0, Math.min(cols - 1, cx + (finalChar === 'C' ? p1 : -p1)));
      else if (finalChar === 'G') cx = Math.min(cols - 1, Math.max(0, p1 - 1));
      else if (finalChar === 'd' || finalChar === 'H' || finalChar === 'f') {
        while (grid.length < Math.min(120, Math.max(rows, p1))) grid.push(makeRow(cols));
        cy = Math.min((rows = grid.length) - 1, Math.max(0, p1 - 1));
        if (finalChar !== 'd') cx = Math.min(cols - 1, Math.max(0, p2 - 1));
      } else if (finalChar === 'J' && (p0 === 2 || p0 === 3)) grid = Array.from({ length: rows }, () => makeRow(cols), (scrollback = []));
      else if (finalChar === 'J') grid = grid.map((r, y) => (p0 === 0 ? y > cy : y < cy) ? makeRow(cols) : (y === cy ? r.map((c, x) => (p0 === 0 ? x >= cx : x <= cx) ? blankCell() : c) : r));
      else if (finalChar === 'K') grid[cy] = grid[cy].map((c, x) => (p0 === 2 || (p0 === 0 && x >= cx) || (p0 === 1 && x <= cx)) ? blankCell() : c);
      else if (finalChar === 'X') grid[cy] = grid[cy].map((c, x) => (x >= cx && x < cx + p1) ? blankCell() : c);
      else if (finalChar === 'P') grid[cy] = [...grid[cy].slice(0, cx), ...grid[cy].slice(cx + p1), ...makeRow(cols)].slice(0, cols);
      else if (finalChar === '@') grid[cy] = [...grid[cy].slice(0, cx), ...makeRow(p1), ...grid[cy].slice(cx)].slice(0, cols);
      else if (finalChar === 'L') grid = [...grid.slice(0, cy), ...Array.from({ length: p1 }, () => makeRow(cols)), ...grid.slice(cy)].slice(0, rows);
      else if (finalChar === 'M') grid = [...grid.slice(0, cy), ...grid.slice(cy + p1), ...Array.from({ length: p1 }, () => makeRow(cols))].slice(0, rows);
      else if (finalChar === 'S' || finalChar === 'T') (finalChar === 'S' ? scrollUp : scrollDown)(p1);
      else if (finalChar === 's') savedPos = [cx, cy];
      else if (finalChar === 'u') [cx, cy] = savedPos;
      else if (finalChar === 'm') applySgr(clean);
    }
    function write(data, { reset = false } = {}) {
      if (reset) {
        scrollback = [];
        grid = Array.from({ length: rows }, () => makeRow(cols));
        cx = (cy = 0);
        pState = 'normal';
        pBuf = '';
        style = blankStyle();
      }
      const str = String(data || '').replace(/\x1b\[H(?:\r?\n)+\x1b\[H/g, '\x1b[H').replace(/(?:\x1b\[K\r?\n)+(?:\x1b\[K)?(?=(?:\x1b\[\?25[lh]|\x1b\[m)*\x1b\[(?:\d+;\d+)?H)/g, '\x1b[J');
      for (let i = 0; i < str.length; i++) {
        const ch = str[i], code = str.charCodeAt(i);
        if (pState === 'normal') {
          if (ch === '\x1b') pState = 'esc';
          else if (ch === '\r') cx = 0;
          else if (ch === '\n') lineFeed();
          else if (ch === '\b' || code === 8) cx = Math.max(0, cx - 1);
          else if (ch === '\t') cx = Math.min(cols - 1, (Math.floor(cx / 8) + 1) * 8);
          else if (code >= 32) {
            if (cx >= cols) lineFeed((cx = 0));
            grid[cy][cx++] = { ch, ...style };
          }
        } else if (pState === 'esc') {
          if (ch === '[' || ch === ']') pBuf = (pState = ch === '[' ? 'csi' : 'osc') && '';
          else {
            if (ch === '7') savedPos = [cx, cy];
            else if (ch === '8') [cx, cy] = savedPos;
            else if (ch === 'c') grid = Array.from({ length: rows }, () => makeRow(cols), (cx = (cy = 0)));
            pState = 'normal';
          }
        } else if (pState === 'csi') {
          if (code >= 0x40 && code <= 0x7e) handleCsi(pBuf, ch);
          pState = (code >= 0x40 && code <= 0x7e) || pBuf.length > 4096 ? 'normal' : pState;
          if (pState === 'csi') pBuf += ch;
        } else if (pState === 'osc') {
          const oscEnd = ch === '\x07' || (ch === '\\' && pBuf.endsWith('\x1b'));
          const m = oscEnd ? (ch === '\\' ? pBuf.slice(0, -1) : pBuf).match(/^[02];([\s\S]*)$/) : null;
          if (m) onTitleChange?.(m[1]);
          pState = oscEnd || pBuf.length > 4096 ? 'normal' : pState;
          if (pState === 'osc') pBuf += ch;
        }
      }
      scheduleRender();
    }
    function renderRowHtml(row, isCursorRow) {
      let end = row.length - 1, html = '';
      while (end >= 0 && row[end].ch === ' ' && !row[end].bg && !row[end].v && !(isCursorRow && end === cx)) end--;
      if (isCursorRow && cx > end) end = Math.min(row.length - 1, cx);
      if (end < 0) return ' ';
      for (let x = 0; x <= end; x++) {
        const c = row[x], isCur = isCursorRow && cursorVisible && x === cx, fg = c.v ? (c.bg || 'var(--hub-bg)') : c.fg, bg = c.v ? (c.fg || 'var(--hub-fg)') : c.bg, ch = ns.escHtml(c.ch || ' ');
        const st = [fg && `color:${fg}`, bg && `background:${bg}`, c.b && 'font-weight:700', c.d && 'opacity:0.65', c.i && 'font-style:italic', c.u && 'text-decoration:underline'].filter(Boolean);
        html += (!st.length && !isCur) ? ch : `<span${isCur ? ' class="term-cursor"' : ''}${st.length ? ` style="${st.join(';')}"` : ''}>${ch}</span>`;
      }
      return html;
    }
    const getSelectionText = () => {
      const sel = window.getSelection?.();
      return (!sel || sel.isCollapsed || (!viewport.contains(sel.anchorNode) && !viewport.contains(sel.focusNode))) ? '' : sel.toString();
    };
    const clearSel = () => {
      window.getSelection?.()?.removeAllRanges();
      onSelectionChange?.(null);
      scheduleRender();
    };
    function flushRender() {
      rafId = 0;
      if (disposed || getSelectionText()) return;
      const lastGridIdx = Math.max(Math.min(grid.length - 1, cy), grid.findLastIndex((r) => !isRowBlank(r)));
      const allRows = [...scrollback, ...grid.slice(0, lastGridIdx + 1)], cursorRowIdx = scrollback.length + cy;
      while (rowEls.length > allRows.length) rowEls.pop()?.remove?.();
      for (let r = 0; r < allRows.length; r++) {
        const html = renderRowHtml(allRows[r], r === cursorRowIdx);
        if (!rowEls[r]) screen.appendChild((rowEls[r] = Object.assign(document.createElement('div'), { className: 'term-row', _h: html, innerHTML: html })));
        else if (rowEls[r]._h !== html) Object.assign(rowEls[r], { _h: html, innerHTML: html });
      }
      screen._rows = rowEls;
      if (stickBottom) viewport.scrollTop = viewport.scrollHeight;
    }
    function scheduleRender() {
      if (rafId || disposed) return;
      rafId = -1;
      const id = requestAnimationFrame(flushRender);
      if (rafId === -1) rafId = id;
    }
    function handleKeyDown(e) {
      const selText = getSelectionText();
      if (selText && (e.altKey || e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.stopPropagation();
        e.preventDefault();
        return void onQuoteShortcut?.(selText);
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && selText) {
        navigator.clipboard?.writeText(selText).catch(() => {});
        clearSel();
        return void e.preventDefault();
      }
      const seq = mapKeyToAnsi(e);
      if (seq === null) return;
      e.preventDefault();
      if (selText) clearSel();
      onInput?.(seq, (stickBottom = true));
    }
    const setFocusState = (foc) => void containerEl.classList?.toggle('is-input-focused', Boolean(foc && !disposed));
    const focusInput = () => setFocusState(true, inputSink.focus({ preventScroll: true }));
    const onWinBlur = () => setFocusState(false), onWinFocus = () => setFocusState(document.activeElement === inputSink);
    ['focus', 'blur'].forEach((ev, i) => inputSink.addEventListener(ev, () => setFocusState(i === 0)));
    ['blur', 'focus'].forEach((ev, i) => window.addEventListener?.(ev, [onWinBlur, onWinFocus][i]));
    inputSink.addEventListener('keydown', handleKeyDown);
    containerEl.addEventListener('keydown', (e) => {
      if (e.target === inputSink) return;
      focusInput();
      handleKeyDown(e);
    });
    inputSink.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      onInput?.(bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text, (stickBottom = true));
    });
    containerEl.addEventListener('mousedown', (e) => { if (!e.target?.closest?.('.term-quote-popup, .term-pane-header')) downPos = { x: e.clientX || 0, y: e.clientY || 0 }; });
    const onWinMouseUp = (e) => {
      if (!downPos || disposed) return;
      const moved = Math.hypot((e.clientX || 0) - downPos.x, (e.clientY || 0) - downPos.y);
      downPos = null;
      setTimeout(() => {
        if (disposed) return;
        const text = moved >= 4 ? getSelectionText() : '';
        if (text) return void onSelectionChange?.({ text, clientX: e.clientX, clientY: e.clientY });
        clearSel();
        focusInput();
      }, 0);
    };
    window.addEventListener?.('mouseup', onWinMouseUp);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const rect = viewport.getBoundingClientRect(), nextCols = Math.max(24, Math.min(240, Math.floor((rect.width - 24) / 7.6))), nextRows = Math.max(6, Math.min(120, Math.floor((rect.height - 16) / 17)));
      if (rect.width < 40 || rect.height < 30 || (nextCols === cols && nextRows === rows)) return;
      while (grid.length > nextRows && isRowBlank(grid.at(-1))) grid.pop();
      while (grid.length > nextRows) {
        const top = grid.shift();
        if (!altState && top && !isRowBlank(top)) scrollback.push(top);
        cy = Math.max(0, cy - 1);
      }
      while (grid.length < nextRows && !altState && scrollback.length > 0 && ++cy) grid.unshift(scrollback.pop());
      while (grid.length < nextRows) grid.push(makeRow(nextCols));
      grid = grid.map((r) => [...r, ...makeRow(Math.max(0, nextCols - r.length))].slice(0, nextCols));
      cx = Math.min(cx, (cols = nextCols) - 1);
      cy = Math.min(cy, (rows = nextRows) - 1);
      scheduleRender();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => !disposed && onResize?.(cols, rows), 60);
    }) : null;
    ro?.observe(viewport);
    return {
      write, flush: flushRender, focus: focusInput, getSelection: getSelectionText, clearSelection: clearSel, getDimensions: () => ({ cols, rows }),
      dispose: () => {
        clearTimeout(resizeTimer, (disposed = true));
        if (rafId) cancelAnimationFrame(rafId);
        ['mouseup', 'blur', 'focus'].forEach((ev, i) => window.removeEventListener?.(ev, [onWinMouseUp, onWinBlur, onWinFocus][i]));
        ro?.disconnect();
      },
    };
  };
})();
