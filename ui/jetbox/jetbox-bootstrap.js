(() => {
  window.process = window.process || { env: { NODE_ENV: 'production' } };
  if (!window.process.platform) {
    const ua = navigator.userAgent || '';
    if (ua.includes('Windows')) {
      window.process.platform = 'win32';
    } else if (ua.includes('Mac')) {
      window.process.platform = 'darwin';
    } else {
      window.process.platform = 'linux';
    }
  }

  const params = window.__HANGAR_JETBOX_PARAMS__ || {};
  const mode = params.mode || 'terminal';
  const cascadeId = params.cascadeId || '';
  const terminalId = params.terminalId || '';
  const quoteDirUri = params.quoteDirUri || '';
  const uiToken = params.uiToken || '';
  const safeTheme = params.safeTheme === 'light' ? 'light' : 'dark';
  const themeQuery = 'hostTheme=' + safeTheme + '&defaultThemeMode=' + safeTheme;

  let userFocusAllowed = false;
  ['pointerdown', 'mousedown', 'keydown'].forEach((ev) => {
    window.addEventListener?.(ev, () => {
      userFocusAllowed = true;
    }, true);
  });
  window.addEventListener?.('blur', () => {
    userFocusAllowed = false;
  });

  const canStealFocus = () => {
    try {
      if (window.parent?.document?.querySelector?.('.agy-rename-input')) {
        return false;
      }
      return Boolean(
        userFocusAllowed ||
        document.hasFocus?.() ||
        window.parent?.document?.hasFocus?.()
      );
    } catch {
      return Boolean(userFocusAllowed || document.hasFocus?.());
    }
  };

  if (window.HTMLElement?.prototype?.focus) {
    const origFocus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function (...args) {
      if (canStealFocus()) {
        return origFocus.apply(this, args);
      }
    };
  }
  if (typeof window.focus === 'function') {
    const origWinFocus = window.focus.bind(window);
    window.focus = function (...args) {
      if (canStealFocus()) {
        return origWinFocus(...args);
      }
    };
  }

  if (uiToken && typeof window.Worker === 'function') {
    const OrigWorker = window.Worker;
    window.Worker = function PatchedWorker(scriptURL, options) {
      let nextUrl = String(scriptURL || '');
      try {
        const u = new URL(nextUrl, window.location.origin);
        if (u.origin === window.location.origin && !u.searchParams.has('token')) {
          u.searchParams.set('token', uiToken);
          nextUrl = u.pathname + u.search + u.hash;
        }
      } catch {}
      return new OrigWorker(nextUrl, options);
    };
    window.Worker.prototype = OrigWorker.prototype;
  }

  let effectiveCascadeId = mode === 'chat'
    ? (cascadeId || 'hangar-sidechat')
    : (terminalId || ((cascadeId && cascadeId !== '_new') ? cascadeId : 'hangar-terminal'));
  const tabId = terminalId ? 'terminal__' + terminalId : 'terminal';

  try {
    const rawLs = window.localStorage;
    const mem = new Map();
    const isoLs = {
      getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : (rawLs?.getItem?.(k) ?? null)),
      setItem: (k, v) => {
        mem.set(String(k), String(v));
      },
      removeItem: (k) => {
        mem.delete(String(k));
      },
      clear: () => {
        mem.clear();
      },
    };
    Object.defineProperty(window, 'localStorage', { value: isoLs, configurable: true });
    if (mode === 'chat') {
      const v1Chat = {
        isPaneOpen: false,
        activeTabId: '',
        tabs: [],
        persistentTabState: {},
      };
      window.localStorage.setItem(
        'aux-pane-session',
        JSON.stringify({
          conversationPanes: { [effectiveCascadeId]: v1Chat },
          newConversationPanes: {},
          homePane: v1Chat,
          conversationScopeProviders: {},
        })
      );
      window.localStorage.setItem(
        'aux-pane-v2-session',
        JSON.stringify({
          version: 1,
          conversationPanes: { [effectiveCascadeId]: { tabs: [], activeTabId: undefined } },
          newConversationPanes: {},
        })
      );
    } else {
      const v1Pane = {
        isPaneOpen: true,
        activeTabId: 'terminal',
        tabs: [],
        persistentTabState: {
          terminal: {
            conversationId: effectiveCascadeId,
            activeTerminalUuid: terminalId,
          },
        },
      };
      window.localStorage.setItem(
        'aux-pane-session',
        JSON.stringify({
          conversationPanes: { [effectiveCascadeId]: v1Pane },
          newConversationPanes: {},
          homePane: v1Pane,
          conversationScopeProviders: { [effectiveCascadeId]: ['terminal'] },
        })
      );
      window.localStorage.setItem(
        'aux-pane-v2-session',
        JSON.stringify({
          version: 1,
          conversationPanes: { [effectiveCascadeId]: { tabs: [], activeTabId: tabId } },
          newConversationPanes: {},
        })
      );
    }
  } catch {}

  if (typeof window.ResizeObserver === 'function') {
    const OrigRO = window.ResizeObserver;
    window.ResizeObserver = class extends OrigRO {
      constructor(cb) {
        super((entries, obs) => {
          if ((Number(window.innerWidth) || 0) < 40 || (Number(window.innerHeight) || 0) < 24) {
            return;
          }
          const valid = entries.filter(
            (e) => (e?.contentRect?.width || 0) >= 40 && (e?.contentRect?.height || 0) >= 24
          );
          if (valid.length) {
            cb(valid, obs);
          }
        });
      }
    };
  }

  try {
    const routeSuffix = mode === 'chat'
      ? '?' + themeQuery
      : '?tab=' + encodeURIComponent(tabId) + '&' + themeQuery;
    history.replaceState(null, '', '/c/' + encodeURIComponent(effectiveCascadeId) + routeSuffix);
  } catch {}

  if (window.customElements) {
    const origDefine = window.customElements.define;
    window.customElements.define = (n, c, o) => {
      if (!window.customElements.get(n)) {
        origDefine.call(window.customElements, n, c, o);
      }
    };
  }

  const origRaf = window.requestAnimationFrame?.bind(window);
  const origCaf = window.cancelAnimationFrame?.bind(window);
  if (origRaf) {
    const rafMap = new Map();
    let nextRafId = 0x40000000;
    window.requestAnimationFrame = (cb) => {
      if (!document.hidden && (Number(window.innerWidth) || 0) > 0) {
        return origRaf(cb);
      }
      const id = nextRafId++;
      let done = false;
      const run = (ts) => {
        if (done) return;
        done = true;
        const entry = rafMap.get(id);
        rafMap.delete(id);
        if (entry?.nId && origCaf) {
          origCaf(entry.nId);
        }
        if (entry?.tId) {
          clearTimeout(entry.tId);
        }
        cb(ts);
      };
      const entry = { nId: 0, tId: 0 };
      rafMap.set(id, entry);
      entry.nId = origRaf(run);
      if (!done) {
        entry.tId = setTimeout(() => run(window.performance?.now?.() || Date.now()), 20);
      }
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const entry = rafMap.get(id);
      if (entry) {
        rafMap.delete(id);
        if (entry.nId && origCaf) {
          origCaf(entry.nId);
        }
        if (entry.tId) {
          clearTimeout(entry.tId);
        }
      } else if (origCaf) {
        origCaf(id);
      }
    };
  }

  let savedThemeVars = null;
  let currentTermTitle = '';
  const applySavedTheme = () => {
    if (!savedThemeVars || !document.documentElement) return;
    for (const [k, v] of Object.entries(savedThemeVars)) {
      if (v) {
        document.documentElement.style.setProperty(k, v);
      }
    }
  };
  const postToParent = (type, payload) => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type, payload }, '*');
    }
  };
  const nativeFetch = window.fetch.bind(window);
  const sidecarFetch = () => (url, opts = {}) => {
    const fn = window.sidecar?.fetch || nativeFetch;
    const headers = {
      ...(opts.headers || {}),
      ...(uiToken ? { 'X-Sidecar-Token': uiToken } : {}),
    };
    return fn(url, { ...opts, headers });
  };
  const LS_PREFIX = '/exa.language_server_pb.LanguageServerService/';
  const GRPC_WEB_HEADERS = { 'Content-Type': 'application/grpc-web+json' };
  const STATE_STUB = {
    appState: { agentOnboardingCompleted: 2 },
    userConfig: { userSettings: { themeMode: safeTheme === 'light' ? 2 : 1 } },
  };

  function encodeConnectFrame(obj, flags = 0) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj ?? {});
    const bytes = new TextEncoder().encode(text);
    const frame = new Uint8Array(5 + bytes.length);
    frame[0] = flags & 0xff;
    new DataView(frame.buffer).setUint32(1, bytes.length, false);
    frame.set(bytes, 5);
    return frame;
  }

  const encodeGrpcTrailer = (status = 0) => encodeConnectFrame('grpc-status: ' + status + '\r\n', 0x80);

  function makeGrpcUnaryResponse(obj) {
    const data = encodeConnectFrame(obj, 0);
    const trailer = encodeGrpcTrailer(0);
    const out = new Uint8Array(data.length + trailer.length);
    out.set(data, 0);
    out.set(trailer, data.length);
    return new window.Response(out, { status: 200, headers: GRPC_WEB_HEADERS });
  }

  const makeGrpcStreamResponse = (initialFrames = []) =>
    new window.Response(
      new ReadableStream({
        start(c) {
          for (const f of initialFrames) {
            c.enqueue(encodeConnectFrame(f, 0));
          }
        },
      }),
      { status: 200, headers: GRPC_WEB_HEADERS }
    );

  function decodeConnectRequest(body) {
    if (!body) return {};
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    }
    try {
      const u8 = body instanceof Uint8Array
        ? body
        : new Uint8Array(body.buffer || body, body.byteOffset || 0, body.byteLength ?? body.length);
      const jsonSlice = u8.length >= 5 && u8[0] === 0
        ? u8.subarray(5, 5 + new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, false))
        : u8;
      return JSON.parse(new TextDecoder().decode(jsonSlice));
    } catch {
      return {};
    }
  }

  function createTerminalConnectStream(reqTerminalId) {
    let afterSeq = 0;
    let cancelled = false;
    let lastTitle = '';
    let lastCwd = '';
    let idlePolls = 0;
    return new ReadableStream({
      async start(controller) {
        while (!cancelled) {
          let hadChunks = false;
          try {
            const res = await sidecarFetch()('/api/terminal/poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ terminalId: reqTerminalId, afterSeq }),
            });
            const data = await res.json();
            const chunks = data.chunks || [];
            hadChunks = chunks.length > 0;
            for (const chunk of chunks) {
              afterSeq = Math.max(afterSeq, chunk.seq || 0);
              if (chunk.outputBase64) {
                controller.enqueue(
                  encodeConnectFrame({ output: chunk.outputBase64, isScrollback: Boolean(chunk.isScrollback) }, 0)
                );
              }
              if (chunk.rawFrame?.title && chunk.rawFrame.title !== lastTitle) {
                lastTitle = chunk.rawFrame.title;
                currentTermTitle = lastTitle;
                controller.enqueue(encodeConnectFrame({ title: lastTitle }, 0));
                postToParent('hangar-jetbox-title-changed', { terminalId: reqTerminalId, title: lastTitle });
              }
              if (chunk.rawFrame?.cwd && chunk.rawFrame.cwd !== lastCwd) {
                lastCwd = chunk.rawFrame.cwd;
                controller.enqueue(encodeConnectFrame({ cwd: lastCwd }, 0));
              }
            }
            if (data.title && data.title !== lastTitle) {
              lastTitle = data.title;
              currentTermTitle = lastTitle;
              controller.enqueue(encodeConnectFrame({ title: data.title }, 0));
              postToParent('hangar-jetbox-title-changed', { terminalId: reqTerminalId, title: data.title });
            }
            if (data.cwd && data.cwd !== lastCwd) {
              lastCwd = data.cwd;
              controller.enqueue(encodeConnectFrame({ cwd: data.cwd }, 0));
            }
            if (data.exited) {
              controller.enqueue(encodeConnectFrame({ exitCode: data.exitCode ?? 0 }, 0));
              controller.enqueue(encodeGrpcTrailer(0));
              controller.close();
              break;
            }
          } catch {}
          idlePolls = hadChunks ? 0 : Math.min(10, idlePolls + 1);
          const delayMs = (document.hidden || (Number(window.innerWidth) || 0) <= 0) ? 1500 : (idlePolls >= 4 ? 180 : 45);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
  }

  function createChatConnectStream(reqBody) {
    let afterSeq = 0;
    let cancelled = false;
    let idlePolls = 0;
    const convId = reqBody?.conversationId || effectiveCascadeId;
    const subId = reqBody?.subscriberId || 'sidechat';
    const verbosity = reqBody?.trajectoryVerbosity ?? 1;
    return new ReadableStream({
      async start(controller) {
        while (!cancelled) {
          let hadChunks = false;
          try {
            const res = await sidecarFetch()('/api/terminal/chat-poll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                conversationId: convId,
                subscriberId: subId,
                trajectoryVerbosity: verbosity,
                afterSeq,
              }),
            });
            const data = await res.json();
            const chunks = data.chunks || [];
            hadChunks = chunks.length > 0;
            for (const chunk of chunks) {
              afterSeq = Math.max(afterSeq, chunk.seq || 0);
              if (chunk.frameData) {
                controller.enqueue(encodeConnectFrame(chunk.frameData, 0));
              }
            }
            if (data.closed) {
              controller.enqueue(encodeGrpcTrailer(0));
              controller.close();
              break;
            }
          } catch {}
          idlePolls = hadChunks ? 0 : Math.min(10, idlePolls + 1);
          const delayMs = (document.hidden || (Number(window.innerWidth) || 0) <= 0) ? 1500 : (idlePolls >= 4 ? 180 : 45);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
  }

  function createSummariesConnectStream() {
    let cancelled = false;
    return new ReadableStream({
      async start(controller) {
        while (!cancelled) {
          if (!document.hidden && (Number(window.innerWidth) || 0) > 0) {
            try {
              const res = await sidecarFetch()('/api/terminal/ls-rpc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'GetAllCascadeTrajectories', body: {} }),
              });
              const data = await res.json().catch(() => ({}));
              if (data?.trajectorySummaries) {
                controller.enqueue(encodeConnectFrame({ updates: data.trajectorySummaries, deletes: [] }, 0));
              }
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 2500));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input?.url || '';
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl, window.location.origin).pathname;
    } catch {}
    if (pathname.startsWith(LS_PREFIX)) {
      const method = pathname.slice(LS_PREFIX.length);
      if (method === 'GetSidecars') return makeGrpcUnaryResponse({ sidecars: [] });
      if (method === 'HasAuthToken') return makeGrpcUnaryResponse({ hasToken: true });
      if (method === 'SubscribeToSidecars') return makeGrpcStreamResponse([{ sidecars: [] }]);
      if (method === 'JetboxReadState') {
        setTimeout(applySavedTheme, 50);
        return makeGrpcUnaryResponse(STATE_STUB);
      }
      if (method === 'JetboxSubscribeToState') return makeGrpcStreamResponse([STATE_STUB]);
      if (method === 'StreamTerminalOutput') {
        const reqTermId = decodeConnectRequest(init.body).terminalId || terminalId;
        return new window.Response(createTerminalConnectStream(reqTermId), {
          status: 200,
          headers: GRPC_WEB_HEADERS,
        });
      }
      if (mode === 'chat' && method === 'StreamAgentStateUpdates') {
        const reqBody = decodeConnectRequest(init.body);
        if (reqBody?.conversationId && reqBody.conversationId !== effectiveCascadeId) {
          postToParent('hangar-sidechat-foreign-nav', {
            cascadeId: reqBody.conversationId,
            expectedCascadeId: effectiveCascadeId,
          });
        }
        return new window.Response(createChatConnectStream(reqBody), {
          status: 200,
          headers: GRPC_WEB_HEADERS,
        });
      }
      if (mode === 'chat' && method === 'JetboxSubscribeToSummaries') {
        return new window.Response(createSummariesConnectStream(), {
          status: 200,
          headers: GRPC_WEB_HEADERS,
        });
      }
      if (
        method.startsWith('Stream') ||
        method.startsWith('Subscribe') ||
        method.startsWith('JetboxSubscribe') ||
        method.startsWith('Watch') ||
        method.endsWith('Stream')
      ) {
        return makeGrpcStreamResponse([]);
      }
      const rpcRes = await sidecarFetch()('/api/terminal/ls-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          body: decodeConnectRequest(init.body),
          targetTerminalId: terminalId,
          targetConversationId: effectiveCascadeId,
        }),
      });
      const rpcPayload = await rpcRes.json().catch(() => ({}));
      if (rpcRes.ok === false) {
        return new window.Response(encodeGrpcTrailer(2), { status: 200, headers: GRPC_WEB_HEADERS });
      }
      return makeGrpcUnaryResponse(rpcPayload);
    }
    return nativeFetch(input, init);
  };

  function buildScopePayload(tid, title, selectionContent) {
    const cleanName = String(title || currentTermTitle || 'terminal')
      .replace(/[\[\]()\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'terminal';
    const baseName = cleanName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'terminal';
    const safeTid = String(tid || terminalId || '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36);
    const safeFile = (safeTid ? baseName + '-' + safeTid : baseName) + '-quote.txt';
    const quoteFileUri = quoteDirUri ? quoteDirUri + '/' + encodeURIComponent(safeFile) : '';
    const termObj = {
      processId: String(tid || terminalId || ''),
      name: cleanName,
      ...(selectionContent ? { selectionContent: String(selectionContent) } : {}),
    };
    const contextScopeJson = JSON.stringify({ terminal: termObj });
    const lexicalJson = JSON.stringify({
      namespace: 'Input',
      nodes: [
        {
          detail: 0,
          format: 0,
          mode: 'segmented',
          style: '',
          text: '',
          trigger: '@',
          value: 'contextScopeItemMention',
          scopeItem: contextScopeJson,
          data: { data: contextScopeJson },
          type: 'contextScopeItemMention',
          version: 1,
        },
        {
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text: ' ',
          type: 'text',
          version: 1,
        },
      ],
    });
    return {
      cleanName,
      contextScopeJson,
      lexicalJson,
      quoteFileUri,
      plainText: '[' + cleanName + '](terminal;' + termObj.processId + ') ',
    };
  }

  function injectTerminalQuoteIntoComposer(quoteOpts = {}, attempt = 0) {
    const ed = document.querySelector?.('[data-lexical-editor="true"]');
    if (!ed && attempt < 50) {
      setTimeout(() => injectTerminalQuoteIntoComposer(quoteOpts, attempt + 1), 40);
      return false;
    }
    const payload = buildScopePayload(
      quoteOpts.terminalId,
      quoteOpts.title || quoteOpts.cleanName,
      quoteOpts.selectionContent
    );
    let dt = null;
    try {
      dt = new DataTransfer();
    } catch {
      const map = {};
      dt = {
        types: [],
        setData(k, v) {
          map[k] = String(v);
          if (!this.types.includes(k)) {
            this.types.push(k);
          }
        },
        getData(k) {
          return map[k] || '';
        },
      };
    }
    dt.setData('application/context-scope-item', payload.contextScopeJson);
    dt.setData('application/context-scope-item-cider', payload.contextScopeJson);
    dt.setData('application/x-lexical-editor', payload.lexicalJson);
    dt.setData('text/plain', payload.plainText);
    let dropEv = null;
    try {
      dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    } catch {
      dropEv = {
        type: 'drop',
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        preventDefault() {},
        stopPropagation() {},
      };
    }
    if (!dropEv.dataTransfer) {
      try {
        Object.defineProperty(dropEv, 'dataTransfer', { value: dt });
      } catch {}
    }
    window.dispatchEvent?.(dropEv);
    if (ed) {
      ed.focus?.();
      if (quoteOpts.promptText) {
        setTimeout(() => {
          ed.focus?.();
          try {
            document.execCommand?.('insertText', false, ' ' + String(quoteOpts.promptText));
          } catch {}
          if (quoteOpts.autoSubmit) {
            setTimeout(() => {
              ed.focus?.();
              try {
                ed.dispatchEvent?.(
                  new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true,
                  })
                );
              } catch {}
            }, 60);
          }
        }, 45);
      }
    }
    postToParent('hangar-sidechat-quote-injected', {
      cascadeId: effectiveCascadeId,
      terminalId: quoteOpts.terminalId || '',
      cleanName: payload.cleanName,
    });
    return true;
  }

  function setOverviewPanelOpen(wantOpen) {
    const open = Boolean(wantOpen);
    if (document.documentElement) {
      if (open) {
        document.documentElement.setAttribute('data-hangar-overview', 'open');
      } else {
        document.documentElement.removeAttribute('data-hangar-overview');
      }
    }
    const ov = document.querySelector?.('[data-testid="overview-panel-host"]');
    const fk = ov && Object.keys(ov).find((k) => k.startsWith('__reactFiber$'));
    for (let f = fk ? ov[fk] : null, d = 0; f && d < 15; d++, f = f.return) {
      const val = f.memoizedProps?.value;
      if (val && typeof val.togglePanel === 'function' && 'isPanelVisible' in val) {
        const curOpen = val.breakpoint === 'small' ? Boolean(val.overlayOpen) : Boolean(val.isPanelVisible);
        if (curOpen !== open) {
          try {
            val.togglePanel();
          } catch {}
        }
        break;
      }
    }
    postToParent('hangar-sidechat-overview-state', { cascadeId: effectiveCascadeId, open });
  }

  function focusJetboxTerminal(attempt = 0) {
    if (!canStealFocus()) return;
    try {
      window.focus?.();
    } catch {}
    const ctx = findTerminalContext();
    const ta = document.querySelector?.('.xterm-helper-textarea');
    if (ctx?.xterm?.focus || ta) {
      try {
        ctx.xterm?.focus?.();
      } catch {}
      try {
        ta?.focus?.({ preventScroll: true });
      } catch {}
    } else if (attempt < 25) {
      setTimeout(() => focusJetboxTerminal(attempt + 1), 40);
    }
  }

  window.addEventListener('message', (e) => {
    if (e?.source === null || (e?.source !== undefined && e.source !== window.parent)) return;
    if (e?.origin !== undefined && e.origin !== window.location?.origin) return;
    if (e.data?.type === 'theme-change' && e.data?.payload?.cssVariables) {
      savedThemeVars = e.data.payload.cssVariables;
      applySavedTheme();
    } else if (e.data?.type === 'hangar-jetbox-shown') {
      try {
        window.dispatchEvent?.(new Event('resize'));
      } catch {}
      if (e.data?.focus !== false) {
        focusJetboxTerminal();
      }
    } else if (e.data?.type === 'hangar-jetbox-focus') {
      focusJetboxTerminal();
    } else if (e.data?.type === 'hangar-clear-selection') {
      const ctx = findTerminalContext();
      try {
        ctx.xterm?.clearSelection?.();
        ctx.dismissPopup?.();
      } catch {}
    } else if (e.data?.type === 'hangar-inject-terminal-quote' && e.data?.payload) {
      if (e.source !== window.parent) return;
      injectTerminalQuoteIntoComposer(e.data.payload);
    } else if (e.data?.type === 'hangar-sidechat-toggle-overview') {
      setOverviewPanelOpen(e.data.open);
    } else if (e.data?.type === 'hangar-sidechat-switch-cascade' && e.data?.payload?.cascadeId) {
      if (e.source !== window.parent) return;
      effectiveCascadeId = String(e.data.payload.cascadeId);
      try {
        history.pushState(null, '', '/c/' + encodeURIComponent(effectiveCascadeId) + '?' + themeQuery);
        let popEv;
        try {
          popEv = new PopStateEvent('popstate');
        } catch {
          popEv = { type: 'popstate' };
        }
        window.dispatchEvent?.(popEv);
      } catch {}
      if (e.data.payload.quote) {
        setTimeout(() => injectTerminalQuoteIntoComposer(e.data.payload.quote), 60);
      }
    }
  });

  function copyScopePayload(payload) {
    let ok = false;
    let probe = null;
    const onCopy = (e) => {
      if (!e.clipboardData) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData('text/plain', payload.plainText);
      e.clipboardData.setData('application/x-lexical-editor', payload.lexicalJson);
      e.clipboardData.setData('application/context-scope-item', payload.contextScopeJson);
      e.clipboardData.setData('application/context-scope-item-cider', payload.contextScopeJson);
      ok = true;
    };
    document.addEventListener('copy', onCopy, true);
    try {
      const sel = window.getSelection?.();
      if (sel && (!sel.rangeCount || sel.isCollapsed) && typeof document.createRange === 'function' && document.body) {
        probe = document.createElement('span');
        probe.textContent = payload.plainText;
        probe.style.position = 'fixed';
        probe.style.left = '-9999px';
        probe.style.top = '-9999px';
        probe.style.opacity = '0';
        probe.style.pointerEvents = 'none';
        document.body.appendChild(probe);
        const range = document.createRange();
        range.selectNodeContents(probe);
        sel.removeAllRanges?.();
        sel.addRange?.(range);
      }
      document.execCommand('copy');
    } catch {}
    document.removeEventListener('copy', onCopy, true);
    if (probe) {
      try {
        window.getSelection?.()?.removeAllRanges?.();
        probe.remove();
      } catch {}
    }
    return ok;
  }

  let cachedQuoteCtx = null;
  let lastReportedSel = '';
  let isHoldingQuoteBtn = false;
  let isDraggingQuote = false;
  let restoreXtermFn = null;

  function findTerminalContext(startNode) {
    const startEl = startNode?.nodeType === 1 ? startNode : startNode?.parentElement;
    const el =
      startEl?.closest?.('[data-testid="terminal-active"]') ||
      document.querySelector('[data-testid^="terminal-pane-"][data-active="true"] [data-testid="terminal-active"]') ||
      document.querySelector('[data-testid="terminal-active"]');
    let selectionText = '';
    let termTitle = currentTermTitle;
    let termId = terminalId;
    let xterm = null;
    let dismissPopup = null;
    let foundProc = false;
    for (const node of [document.querySelector('.selection-popup'), el]) {
      const fk = node && Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      for (let f = fk ? node[fk] : null, d = 0; f && d < 18; d++, f = f.return) {
        const p = f.memoizedProps;
        const selTxt = p?.selection?.text || p?.selection?.context?.textSelection;
        const dismiss = p?.onDismiss || p?.dismiss;
        const proc = p?.process || p?.terminal || p?.activeTerminal;
        if (selTxt && !selectionText) {
          selectionText = selTxt;
        }
        if (typeof dismiss === 'function' && !dismissPopup) {
          dismissPopup = dismiss;
        }
        if (proc?.terminalId && !foundProc) {
          termId = proc.terminalId;
          if (proc.title) {
            termTitle = proc.title;
          }
          foundProc = true;
        }
        for (let s = f.memoizedState; s && !xterm; s = s.next) {
          const cand = typeof s.memoizedState?.getSelection === 'function'
            ? s.memoizedState
            : (typeof s.memoizedState?.current?.getSelection === 'function' ? s.memoizedState.current : null);
          if (cand) {
            xterm = cand;
          }
        }
      }
    }
    const finalSelection =
      selectionText ||
      xterm?.getSelection?.() ||
      window.getSelection?.()?.toString?.() ||
      cachedQuoteCtx?.selectionText ||
      lastReportedSel ||
      '';
    return {
      selectionText: finalSelection,
      termId,
      termTitle,
      xterm,
      dismissPopup,
    };
  }

  if (mode === 'chat') {
    window.addEventListener?.('click', (e) => {
      const tgt = e.target?.closest ? e.target : e.target?.parentElement;
      if (tgt?.getAttribute?.('data-testid') === 'overview-panel-overlay-backdrop') {
        setOverviewPanelOpen(false);
        return;
      }
      if (tgt?.closest?.('[data-testid="overview-panel-row-terminal"]')) {
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
        setOverviewPanelOpen(false);
        postToParent('hangar-sidechat-open-terminal', { cascadeId: effectiveCascadeId });
      }
    }, true);
    return;
  }

  const getPopupBtn = (t) => (t?.closest ? t : t?.parentElement)?.closest?.('.selection-popup button');
  const releaseQuoteHold = (clearSel) => {
    isHoldingQuoteBtn = false;
    if (restoreXtermFn) {
      try {
        restoreXtermFn();
      } catch {}
      restoreXtermFn = null;
    }
    if (clearSel && cachedQuoteCtx) {
      try {
        cachedQuoteCtx.xterm?.clearSelection?.();
        cachedQuoteCtx.dismissPopup?.();
      } catch {}
      cachedQuoteCtx = null;
    }
  };

  document.addEventListener?.('selectionchange', (e) => {
    if (isHoldingQuoteBtn) {
      e.stopImmediatePropagation?.();
    }
  }, true);

  function ensureAskButton() {
    const popup = document.querySelector?.('.selection-popup');
    const quoteBtn = popup?.querySelector?.('button:not([data-hangar-ask])');
    if (!popup || !quoteBtn) return;
    quoteBtn.draggable = true;
    quoteBtn.setAttribute?.('draggable', 'true');
    if (quoteBtn.style) {
      quoteBtn.style.webkitUserDrag = 'element';
    }
    if (!popup.querySelector?.('[data-hangar-ask]')) {
      if (quoteBtn.className) {
        quoteBtn.className = quoteBtn.className.replace(/\bflex-1\b/g, '').trim();
      }
      const askBtn = document.createElement('button');
      const row = quoteBtn.parentElement || popup;
      askBtn.type = 'button';
      askBtn.className = ((quoteBtn.className || '') + ' border-l border-border whitespace-nowrap').trim();
      askBtn.setAttribute?.('data-hangar-ask', 'true');
      askBtn.draggable = false;
      askBtn.setAttribute?.('draggable', 'false');
      askBtn.innerHTML = '<span>Quote &amp; Ask</span>';
      row.appendChild?.(askBtn);
    }
    const vw = Number(window.innerWidth) || document.documentElement?.clientWidth || 0;
    const pRect = popup.offsetParent?.getBoundingClientRect?.();
    const maxR = Math.min(vw > 0 ? vw : Infinity, pRect?.right > 0 ? pRect.right : Infinity) - 8;
    const r = popup.getBoundingClientRect?.();
    if (Number.isFinite(maxR) && r && r.width > 0 && popup.style) {
      const curL = parseFloat(popup.style.left);
      if (r.right > maxR + 0.5 && !Number.isNaN(curL)) {
        const nextL = Math.max(8, Math.round(curL - (r.right - maxR)));
        if (Math.abs(nextL - curL) >= 1) {
          popup.style.left = nextL + 'px';
        }
      } else if (r.left < 7.5 && !Number.isNaN(curL)) {
        const nextL = Math.round(curL + (8 - r.left));
        if (Math.abs(nextL - curL) >= 1) {
          popup.style.left = nextL + 'px';
        }
      }
    }
  }

  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(ensureAskButton).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  }

  function triggerJetboxQuote(ctx, askAgent = false) {
    if (!ctx?.selectionText?.trim()) return false;
    const copied = copyScopePayload(buildScopePayload(ctx.termId, ctx.termTitle, ctx.selectionText));
    releaseQuoteHold(false);
    try {
      ctx.xterm?.clearSelection?.();
      ctx.dismissPopup?.();
    } catch {}
    postToParent('hangar-jetbox-quote-clicked', {
      terminalId: ctx.termId,
      title: ctx.termTitle,
      selectionContent: ctx.selectionText,
      copied,
      askAgent: Boolean(askAgent),
    });
    return true;
  }

  const saveQuoteFile = (ctx) => {
    if (!ctx?.selectionText?.trim()) return;
    try {
      sidecarFetch()('/api/terminal/ls-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'WriteQuoteFile',
          conversationId: cascadeId,
          terminalId: ctx.termId || terminalId,
          name: ctx.termTitle || currentTermTitle || 'terminal',
          selectionContent: ctx.selectionText,
        }),
      }).catch(() => {});
    } catch {}
  };

  ['pointerdown', 'focusin'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (getPopupBtn(e.target)) {
        e.stopPropagation();
        return;
      }
      postToParent('hangar-jetbox-pane-focused', { terminalId });
    }, true);
  });

  window.addEventListener('mousedown', (e) => {
    ensureAskButton();
    const btn = getPopupBtn(e.target);
    if (!btn) {
      if (isHoldingQuoteBtn && !isDraggingQuote) {
        releaseQuoteHold(false);
      }
      return;
    }
    cachedQuoteCtx = findTerminalContext(btn);
    saveQuoteFile(cachedQuoteCtx);
    e.stopPropagation();
    if (btn.getAttribute?.('data-hangar-ask') === 'true') {
      e.preventDefault();
      return;
    }
    btn.draggable = true;
    btn.setAttribute?.('draggable', 'true');
    isHoldingQuoteBtn = true;
    isDraggingQuote = false;
    const xt = cachedQuoteCtx?.xterm;
    const lockedTxt = cachedQuoteCtx?.selectionText || '';
    if (xt && lockedTxt && !restoreXtermFn) {
      const origClr = xt.clearSelection;
      const origGet = xt.getSelection;
      xt.clearSelection = () => {};
      xt.getSelection = () => lockedTxt;
      restoreXtermFn = () => {
        xt.clearSelection = origClr;
        xt.getSelection = origGet;
      };
    }
  }, true);

  window.addEventListener('dragstart', (e) => {
    const btn = getPopupBtn(e.target);
    const ctx = btn && e.dataTransfer
      ? (cachedQuoteCtx?.selectionText ? cachedQuoteCtx : findTerminalContext(btn))
      : null;
    if (!ctx?.selectionText?.trim()) return;
    isDraggingQuote = true;
    saveQuoteFile(ctx);
    e.stopPropagation?.();
    const payload = buildScopePayload(ctx.termId, ctx.termTitle, ctx.selectionText);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('application/context-scope-item', payload.contextScopeJson);
    e.dataTransfer.setData('application/context-scope-item-cider', payload.contextScopeJson);
    e.dataTransfer.setData('application/x-lexical-editor', payload.lexicalJson);
    e.dataTransfer.setData('text/plain', payload.plainText);
  }, true);

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      e.stopPropagation?.();
      const hasScopeMime = Array.from(e.dataTransfer?.types || []).some((t) =>
        String(t).includes('context-scope-item')
      );
      if ((ev === 'dragenter' || ev === 'dragover') && (isDraggingQuote || hasScopeMime)) {
        e.preventDefault?.();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }
    }, true);
  });

  window.addEventListener('dragend', (e) => {
    const ctx = cachedQuoteCtx;
    const sel = ctx?.selectionText?.trim() || '';
    const tid = ctx?.termId || terminalId;
    const ttl = ctx?.termTitle || currentTermTitle || 'terminal';
    if (sel) {
      copyScopePayload(buildScopePayload(tid, ttl, sel));
      const cx = Number(e?.clientX) || 0;
      const cy = Number(e?.clientY) || 0;
      const vw = Number(window.innerWidth) || 0;
      const vh = Number(window.innerHeight) || 0;
      const outside = (cx < 0 || cy < 0 || (vw > 0 && cx > vw) || (vh > 0 && cy > vh)) && !(cx === 0 && cy === 0);
      postToParent('hangar-jetbox-quote-dragend', {
        terminalId: tid,
        title: ttl,
        selectionContent: sel,
        clientX: cx,
        clientY: cy,
        outsideFrame: outside,
        dropEffect: e?.dataTransfer?.dropEffect || 'none',
      });
      if (outside && (!window.parent || window.parent === window)) {
        try {
          sidecarFetch()('/api/terminal/ls-rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              method: 'InjectQuoteDrop',
              conversationId: cascadeId,
              terminalId: tid,
              name: ttl,
              selectionContent: sel,
            }),
          }).catch(() => {});
        } catch {}
      }
    }
    isDraggingQuote = false;
    releaseQuoteHold(true);
  }, true);

  window.addEventListener('click', (e) => {
    if (mode === 'chat' && e.target?.closest?.('div[title="Open side-by-side view"]')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const btn = getPopupBtn(e.target);
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const isAsk = btn.getAttribute?.('data-hangar-ask') === 'true' || btn.dataset?.hangarAsk === 'true';
      const ctx = cachedQuoteCtx?.selectionText ? cachedQuoteCtx : findTerminalContext(btn);
      triggerJetboxQuote(ctx, isAsk);
      cachedQuoteCtx = null;
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    const isAltOnly = e.altKey && !e.ctrlKey && !e.metaKey;
    const isModOnly = (e.metaKey || e.ctrlKey) && !e.altKey;
    const isQuoteKey = (isAltOnly || isModOnly) && !e.shiftKey && e.key?.toLowerCase?.() === 'l';
    const ctx = isQuoteKey ? findTerminalContext(e.target) : null;
    if (ctx?.selectionText?.trim()) {
      e.preventDefault();
      e.stopPropagation();
      triggerJetboxQuote(ctx, false);
    }
  }, true);

  const syncSelection = (e) => {
    if (e?.type === 'mouseup' && getPopupBtn(e.target)) {
      e.stopPropagation();
    }
    if (e?.type === 'mouseup' && isHoldingQuoteBtn && !isDraggingQuote) {
      setTimeout(() => {
        if (!isDraggingQuote) {
          releaseQuoteHold(false);
        }
      }, 0);
    }
    if (isHoldingQuoteBtn || isDraggingQuote) return;
    setTimeout(() => {
      if (isHoldingQuoteBtn || isDraggingQuote) return;
      ensureAskButton();
      setTimeout(ensureAskButton, 35);
      const ctx = findTerminalContext(e?.target);
      if (ctx.selectionText?.trim()) {
        cachedQuoteCtx = ctx;
        saveQuoteFile(ctx);
      }
      if (ctx.selectionText !== lastReportedSel) {
        lastReportedSel = ctx.selectionText;
        postToParent('hangar-jetbox-selection-changed', {
          terminalId: ctx.termId,
          title: ctx.termTitle,
          selectionContent: ctx.selectionText,
        });
      }
    }, 15);
  };

  ['mouseup', 'keyup', 'blur', 'mouseleave'].forEach((ev) => {
    window.addEventListener(ev, syncSelection, true);
  });
})();
