import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Channel } from "mygo-runtime";
import { ArrowLeft, PictureInPicture2, Settings as SettingsIcon } from "lucide-preact";
import { Finder, Launcher, Windows, events, type AppInfo, type Batch, type ConfigView, type ExecEvent, type Item, type PayloadInfo, type Scope, type View } from "../mygo";
import type { FeatureCtx } from "../features/types";
import { featureIcons, featureTitles } from "../features/meta";
import { Icon, PocketLogo } from "../shared/icons";
import { applyAppearance, applyUserStyles, keyLabel } from "../shared/theme";
import { ActionPanel } from "./actions";
import { Results, Home } from "./results";
import { ViewPane, type ActiveView } from "./views";
import { hooks, installUserScript, keymap, setQueryBridge, matchShortcut, matchAccelerator } from "./user";
import { formatAccelerator } from "../shared/theme";

const HOME_COLUMNS = 8;

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope | null>(null);
  const [batch, setBatch] = useState<Batch>({ mode: "home", items: [], done: true });
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<ActiveView | null>(null);
  const viewRef = useRef<ActiveView | null>(null);
  viewRef.current = view;
  const [actionsOpen, setActionsOpen] = useState(false);
  // 右键打开动作面板时记下鼠标的位置，面板就在那里弹出；键盘打开时为空，面板停在右下角。
  const [actionsAt, setActionsAt] = useState<{ x: number; y: number } | null>(null);
  const actionsOpenRef = useRef(false);
  actionsOpenRef.current = actionsOpen;
  const [confirm, setConfirm] = useState<{ text: string; item: string; action: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [modHeld, setModHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(0); // 每次唤出时换一个值，触发弹入动画
  // 带入的一块内容（选中的文字、刚复制或粘贴的文字、图片、文件）。它和输入的文字分开：
  // 块后面输入的是「用哪个功能处理它」。内容本身留在后端，这里只有显示用的信息。
  const [payload, setPayloadState] = useState<PayloadInfo | null>(null);
  const payloadRef = useRef<PayloadInfo | null>(null);
  const setPayload = useCallback((p: PayloadInfo | null) => {
    payloadRef.current = p;
    setPayloadState(p);
  }, []);

  const input = useRef<HTMLInputElement>(null);
  const querySeq = useRef(0);
  const queryChannel = useRef<Channel<Batch> | null>(null);
  const execChannel = useRef<Channel<ExecEvent> | null>(null);
  const selectedId = useRef<string | null>(null);
  const userMoved = useRef(false);
  const composing = useRef(false);
  const latest = useRef({ text, scope });
  latest.current = { text, scope };
  const latestView = useRef<ActiveView | null>(null);
  latestView.current = view;
  const featureInput = useRef<string | null>(null); // 功能页里当前输入的内容
  const viewNonce = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const items = batch.items;
  const current: Item | undefined = items[selected];
  const keys = keyLabel(info?.platform ?? "darwin");
  const appearance = config?.config.appearance;

  // --- 查询 ---
  const runQuery = useCallback((queryText: string, queryScope: Scope | null, keepSelection = false) => {
    const seq = ++querySeq.current;
    queryChannel.current?.close();
    if (!keepSelection) {
      selectedId.current = null;
      userMoved.current = false;
    }
    const busyTimer = setTimeout(() => {
      if (seq === querySeq.current) setBusy(true);
    }, 300);
    const ch = new Channel<Batch>((b) => {
      if (seq !== querySeq.current) return;
      if (b.done) {
        clearTimeout(busyTimer);
        setBusy(false);
      }
      const list = hooks.results(b.items ?? [], { text: queryText, scope: queryScope?.id ?? "" });
      setBatch((prev) => {
        // 作用域里的脚本结果晚到：等到有内容再换，不闪空白。
        if (!b.done && list.length === 0 && prev.items.length > 0 && queryScope) return prev;
        return { ...b, items: list };
      });
      // 选中项跟着条目走：晚到的结果插进来时，回车执行的还是看到的那一行。
      // 例外：用户没动过选择、而当前选中的只是兜底项（网页搜索）时，有了真正的结果就选真正的结果。
      const keep = selectedId.current;
      const found = keep ? list.findIndex((it) => it.id === keep) : -1;
      const stale = found >= 0 && !!list[found]?.fallback && !userMoved.current;
      const next = found >= 0 && !stale ? found : 0;
      setSelected(next);
      selectedId.current = list[next]?.id ?? null;
    });
    queryChannel.current = ch;
    const finalText = hooks.query(queryText);
    const payloadId = queryScope ? undefined : payloadRef.current?.id;
    Launcher.query({ text: finalText, scope: queryScope?.id, payload: payloadId }, ch).catch((err) => {
      if (seq === querySeq.current) showToast(errorText(err), true);
    });
  }, []);

  const showToast = useCallback((message: string, error = false) => {
    setToast({ text: message, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 5000 : 1800);
  }, []);

  const setInput = useCallback(
    (value: string) => {
      setText(value);
      runQuery(value, latest.current.scope);
      input.current?.focus();
    },
    [runQuery],
  );

  const enterScope = useCallback(
    (s: Scope) => {
      setView(null);
      setScope(s);
      setText("");
      setActionsOpen(false);
      runQuery("", s);
      input.current?.focus();
    },
    [runQuery],
  );

  const exitScope = useCallback(() => {
    setScope(null);
    setText("");
    runQuery("", null);
  }, [runQuery]);

  const closeView = useCallback(() => {
    execChannel.current?.close();
    execChannel.current = null;
    setView(null);
    setTimeout(() => input.current?.focus());
  }, []);

  const detachable = (v: ActiveView | null) => !!v && (v.type === "feature" || (v.type === "panel" && !!v.url));

  const detachView = useCallback(() => {
    const v = latestView.current;
    if (!v || !detachable(v)) return;
    void Windows.detach({
      feature: v.feature, input: featureInput.current ?? v.input, args: v.args, url: v.url, plugin: v.plugin,
      title: v.title ?? "", icon: v.icon, height: v.height,
    }).then(
      () => {
        execChannel.current?.close();
        setView(null);
      },
      (err: Error) => showToast(err.message, true),
    );
  }, [showToast]);

  const resetAll = useCallback(() => {
    execChannel.current?.close();
    execChannel.current = null;
    setView(null);
    setScope(null);
    setText("");
    setPayload(null);
    setActionsOpen(false);
    setConfirm(null);
    setToast(null);
  }, [setPayload]);

  /** 把块变回普通文字放进输入框并默认全选（方便继续编辑或直接按退格/输入清空替换）；图片和文件的块直接去掉。 */
  const editPayload = useCallback(() => {
    const p = payloadRef.current;
    if (!p) return;
    setPayload(null);
    if (p.kind !== "text") {
      runQuery(latest.current.text, null);
      setTimeout(() => input.current?.focus());
      return;
    }
    void Launcher.payloadText(p.id).then((full) => {
      const value = full.replace(/\s*\n\s*/g, " ") + latest.current.text;
      setText(value);
      runQuery(value, null);
      setTimeout(() => {
        const el = input.current;
        if (el) {
          el.focus();
          el.select();
        }
      });
    });
  }, [runQuery, setPayload]);

  /** 粘贴：图片和文件做成一块；输入框空着时，文字也做成一块（后面可以接着输入功能名）。 */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      const pastedText = dt?.getData("text/plain") ?? "";
      const hasFiles = (dt?.files.length ?? 0) > 0 || Array.from(dt?.types ?? []).includes("Files");
      const el = e.target as HTMLInputElement;
      const asBlock = hasFiles || !pastedText || (el.value === "" && !latest.current.scope);
      if (!asBlock) return; // 已经在打字了：照常粘贴进文字里
      e.preventDefault();
      void Launcher.clipboardPayload().then((p) => {
        if (!p) return;
        if (p.kind === "text" && latest.current.scope) return;
        setScope(null);
        setPayload(p);
        runQuery(latest.current.scope ? "" : latest.current.text, null);
      });
    },
    [runQuery, setPayload],
  );

  /**
   * 在输入框的空白处按住拖动，可以移动窗口（和 uTools 一样，整条搜索框都能拖）。
   * 按在文字上仍然是选择文字。标题栏其余部分用原生的拖动区域。
   */
  const onInputMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLInputElement;
    const style = getComputedStyle(el);
    const ctx2d = document.createElement("canvas").getContext("2d");
    let textWidth = 0;
    if (ctx2d && el.value) {
      ctx2d.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      textWidth = ctx2d.measureText(el.value).width;
    }
    if (e.clientX - el.getBoundingClientRect().left < textWidth + 10) return;
    const start = { x: e.screenX, y: e.screenY };
    let started: Promise<void> | null = null;
    let frame = 0;
    let last = start;
    const onMove = (m: MouseEvent) => {
      last = { x: m.screenX, y: m.screenY };
      if (!started) {
        if (Math.abs(last.x - start.x) + Math.abs(last.y - start.y) < 4) return;
        started = Windows.dragStart();
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void started?.then(() => Windows.dragMove(Math.round(last.x - start.x), Math.round(last.y - start.y)));
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // --- 执行 ---
  const handleExec = useCallback(
    (ev: ExecEvent, pending: { item: string; action: number }) => {
      switch (ev.kind) {
        case "hide":
          setActionsOpen(false);
          break;
        case "view":
          if (ev.view) setView({ ...ev.view, content: ev.view.content ?? "", streaming: !!ev.view.stream });
          setActionsOpen(false);
          break;
        case "append":
          setView((v) => (v ? { ...v, content: ev.replace ? (ev.text ?? "") : (v.content ?? "") + (ev.text ?? "") } : v));
          break;
        case "done":
          setView((v) => (v ? { ...v, streaming: false } : v));
          break;
        case "toast":
          showToast(ev.text ?? "");
          break;
        case "error":
          showToast(ev.text ?? "执行失败", true);
          break;
        case "scope":
          if (ev.scope) enterScope(ev.scope);
          break;
        case "input":
          setActionsOpen(false);
          setInput(ev.text ?? "");
          break;
        case "confirm":
          setActionsOpen(false);
          setConfirm({ text: ev.text ?? "确定要执行吗？", item: pending.item, action: pending.action });
          break;
        case "refresh":
          setActionsOpen(false);
          runQuery(latest.current.text, latest.current.scope, true);
          break;
      }
    },
    [enterScope, runQuery, setInput, showToast],
  );

  const execute = useCallback(
    (itemId: string, action: number, options: { confirmed?: boolean; args?: Record<string, string> } = {}) => {
      execChannel.current?.close();
      const pending = { item: itemId, action };
      const ch = new Channel<ExecEvent>((ev) => handleExec(ev, pending));
      execChannel.current = ch;
      Launcher.execute(
        { item: itemId, action, query: latest.current.text, confirmed: options.confirmed, args: options.args },
        ch,
      ).catch((err) => {
        setActionsOpen(false);
        showToast(errorText(err), true);
      });
    },
    [handleExec, showToast],
  );

  const select = useCallback((index: number) => {
    // 动作面板开着时，它对应的那一项不能再变：鼠标划过别的项不改选中。
    if (actionsOpenRef.current) return;
    setSelected(index);
    selectedId.current = batch.items[index]?.id ?? null;
    userMoved.current = true;
  }, [batch.items]);

  const openActionsAt = useCallback(
    (index: number, at: { x: number; y: number }) => {
      actionsOpenRef.current = false;
      select(index);
      setActionsAt(at);
      setActionsOpen(true);
    },
    [select],
  );
  const closeActions = useCallback(() => {
    setActionsOpen(false);
    setActionsAt(null);
    input.current?.focus();
  }, []);

  // --- 初始化 ---
  useEffect(() => {
    void (async () => {
      const [i, c, assets] = await Promise.all([Launcher.info(), Launcher.config(), Launcher.assets()]);
      setInfo(i);
      setConfig(c);
      applyAppearance(c, i);
      applyUserStyles(assets);
      installUserScript(assets.userJs);
      runQuery("", null);
    })();
  }, [runQuery]);

  useEffect(() => {
    setQueryBridge({ get: () => latest.current.text, set: setInput });
  }, [setInput]);

  useEffect(() => {
    void Launcher.setInTool(Boolean(view || scope));
  }, [view, scope]);

  useEffect(() => {
    const offs = [
      events.panelShown.on((shown) => {
        setConfirm(null);
        setActionsOpen(false);
        if (shown.resume) {
          // 截图期间临时收起，现在原样回来：页面上的内容都不动。
          return;
        }
        setEntering((n) => n + 1);
        if (shown.payload) {
          resetAll();
          setPayload(shown.payload);
          runQuery("", null);
          setTimeout(() => input.current?.focus());
          return;
        }
        if (shown.view) {
          resetAll();
          runQuery("", null);
          // 换一个编号让页面重新挂载：连续两次进同一个功能页（比如连着截两次图）时，要用新的参数从头开始。
          viewNonce.current++;
          setView({ ...shown.view, content: shown.view.content ?? "", streaming: false });
          return;
        }
        if (shown.query) {
          resetAll();
          setText(shown.query);
          runQuery(shown.query, null);
        } else if (viewRef.current) {
          // 停留在已打开的工具页面时，无论隐藏多久，再次唤出都原样回到这个工具。
          return;
        } else if (latest.current.scope) {
          // 停留在命令作用域里时同样保留作用域；超过记忆时间只清掉作用域里的搜索文字。
          const keepText = shown.keep ? latest.current.text : "";
          setText(keepText);
          setPayload(null);
          runQuery(keepText, latest.current.scope);
          if (shown.keep) setTimeout(() => input.current?.select());
        } else if (shown.keep) {
          runQuery(latest.current.text, latest.current.scope);
          setTimeout(() => input.current?.select());
        } else {
          resetAll();
          runQuery("", null);
        }
        setTimeout(() => input.current?.focus());
      }),
      events.panelPayload.on((p) => {
        // 选中的文字读得慢时，窗口先出来，内容随后补上。这时如果已经开始打字或进了别的页面，就不打扰了。
        if (latest.current.text || latest.current.scope || payloadRef.current || viewRef.current) return;
        setPayload(p);
        runQuery("", null);
      }),
      events.configChanged.on((c) => {
        setConfig(c);
        setInfo((i) => {
          if (i) applyAppearance(c, i);
          return i;
        });
      }),
      events.resultsChanged.on(() => runQuery(latest.current.text, latest.current.scope, true)),
      events.assetsChanged.on((assets) => {
        applyUserStyles(assets);
        installUserScript(assets.userJs);
      }),
      events.execExternal.on((ev) => handleExec(ev, { item: "", action: 0 })),
    ];
    return () => offs.forEach((off) => off());
  }, [handleExec, resetAll, runQuery, setPayload]);

  // 把选中项滚到可见范围。只滚列表自己，不用 scrollIntoView：它会连整个页面一起滚动。
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(".is-selected");
    const box = row?.closest<HTMLElement>(".pk-list");
    if (!row || !box) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 6) box.scrollTop = Math.max(top - 6, 0);
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight - 6) box.scrollTop = top + row.offsetHeight - box.clientHeight + 6;
  }, [selected, batch]);

  // 窗口跟随内容的大小。
  const panel = useRef<HTMLDivElement>(null);
  // 每次唤出重新播放弹入动画：先去掉类名、强制重排，再加回来。
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !entering) return;
    el.classList.remove("pk-enter");
    void el.offsetWidth;
    el.classList.add("pk-enter");
  }, [entering]);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    let last = "";
    const report = () => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      const key = `${w}x${h}`;
      if (key !== last) {
        last = key;
        void Launcher.resize(w, h);
      }
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, []);

  // --- 键盘 ---
  const isHome = batch.mode === "home" && !scope;
  const moveSelection = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = (selected + delta + items.length) % items.length;
      select(next);
    },
    [items.length, select, selected],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || composing.current || e.keyCode === 229) return;
    const mod = keys.mac ? e.metaKey : e.ctrlKey;

    if (keymap.dispatch(e, keys.mac)) {
      e.preventDefault();
      return;
    }

    if (confirm) {
      if (e.key === "Enter") {
        e.preventDefault();
        const c = confirm;
        setConfirm(null);
        execute(c.item, c.action, { confirmed: true });
      } else if (e.key === "Escape") {
        e.preventDefault();
        setConfirm(null);
      }
      return;
    }

    if (actionsOpen) return; // 动作面板自己处理

    if (view) {
      if (detachable(view) && matchAccelerator(e, detachKey, keys.mac)) {
        e.preventDefault();
        detachView();
      }
      return; // Esc 在冒泡阶段处理：功能页里的弹层可以先拦下它
    }

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (text && scope) {
          setText("");
          runQuery("", scope);
        } else if (scope) {
          exitScope();
        } else if (text) {
          setText("");
          runQuery("", null);
        } else {
          void Launcher.hide();
        }
        return;
      case "ArrowDown":
        e.preventDefault();
        moveSelection(isHome ? HOME_COLUMNS : 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveSelection(isHome ? -HOME_COLUMNS : -1);
        return;
      case "ArrowRight":
        if (isHome) {
          e.preventDefault();
          moveSelection(1);
        }
        return;
      case "ArrowLeft":
        if (isHome) {
          e.preventDefault();
          moveSelection(-1);
        }
        return;
      case "Enter":
        e.preventDefault();
        if (current) execute(current.id, mod && (current.actions?.length ?? 0) > 1 ? 1 : 0);
        return;
      case "Tab":
        e.preventDefault();
        if (current?.scope) enterScope(current.scope);
        else if (current?.complete) setInput(current.complete);
        return;
      case "Backspace":
        if (!text && scope) {
          e.preventDefault();
          exitScope();
        } else if (!text && payload && !mod) {
          e.preventDefault();
          editPayload();
        } else if (mod && current) {
          const index = current.actions?.findIndex((a) => a.shortcut === "mod+backspace") ?? -1;
          if (index >= 0) {
            e.preventDefault();
            execute(current.id, index);
          }
        }
        return;
    }

    if (e.ctrlKey && !e.metaKey && (e.key === "n" || e.key === "p")) {
      e.preventDefault();
      moveSelection(e.key === "n" ? 1 : -1);
      return;
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (current) {
        setActionsAt(null);
        setActionsOpen(true);
      }
      return;
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      void Launcher.openSettings("");
      return;
    }
    // 动作自带的快捷键（编辑源文件、固定……）。
    if (current?.actions) {
      const index = current.actions.findIndex((a) => a.shortcut && matchShortcut(e, a.shortcut, keys.mac));
      if (index >= 0) {
        e.preventDefault();
        execute(current.id, index);
        return;
      }
    }
    // 直接执行第 N 项：macOS 用 ⌘，Windows 用 Alt。
    const indexMod = keys.mac ? e.metaKey : e.altKey;
    if (indexMod && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      const target = items[Number(e.code.slice(5)) - 1];
      if (target) execute(target.id, 0);
    }
  };

  useEffect(() => {
    const onModifier = (e: KeyboardEvent) => setModHeld(keys.mac ? e.metaKey : e.altKey);
    const onBlur = () => setModHeld(false);
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
      window.removeEventListener("blur", onBlur);
    };
  }, [keys.mac]);

  const detachKey = config?.config.keys?.detach || "CmdOrCtrl+D";
  const detachLabel = formatAccelerator(detachKey, info?.platform ?? "darwin");

  const featureCtx: FeatureCtx = {
    detached: false,
    stealth: false,
    platform: info?.platform ?? "darwin",
    toast: showToast,
    copy: (t: string, label?: string) => Launcher.copyText(t).then(() => showToast(label ?? "已复制")),
    open: (feature, featureInput, args) =>
      setView({ type: "feature", feature, title: featureTitles[feature] ?? feature, icon: featureIcons[feature], input: featureInput ?? "", args: args ?? {}, content: "" }),
    close: closeView,
    detach: detachView,
    detachKey,
    remember: (value) => {
      featureInput.current = value;
    },
    openSettings: (section) => void Launcher.openSettings(section),
  };

  const onBubbleKeyDown = (e: KeyboardEvent) => {
    if (view && e.key === "Escape" && !e.defaultPrevented && !actionsOpen && !confirm) {
      e.preventDefault();
      closeView();
    }
  };

  const placeholder =
    scope?.placeholder ??
    (payload
      ? payload.kind === "text"
        ? "输入功能名来处理这段文字，例如 翻译、md5"
        : payload.kind === "image"
          ? "输入功能名来处理这张图片，例如 识别、保存"
          : "输入功能名来处理这些文件"
      : "搜索应用、文件、命令，或者输入算式…");
  const showPreview = !!appearance?.showPreview && !isHome && !view;
  const showMeta = !!appearance?.showMeta && !isHome && !view;
  // 选中的是文件时，底栏给出预览区和属性区的开关。
  const filePanes = !isHome && !view && current?.preview?.type === "file";
  const setPanes = (preview: boolean, meta: boolean) => void Finder.setPanes("panel", preview, meta);

  const footerHint = useMemo(() => {
    const first = current?.actions?.[0]?.title;
    return first ?? "";
  }, [current]);

  return (
    <div ref={panel} class={`pk-panel${actionsOpen ? " has-actions" : ""}`} onKeyDownCapture={onKeyDown} onKeyDown={onBubbleKeyDown}>
      <header class="pk-header">
        {view ? (
          <button class="pk-back" title="返回（Esc）" onClick={closeView}>
            <ArrowLeft size={18} strokeWidth={2} />
          </button>
        ) : scope ? (
          <button class="pk-scope" title="退出（Esc）" onClick={exitScope}>
            <Icon icon={scope.icon} size={20} />
            <span>{scope.title}</span>
          </button>
        ) : (
          <div class="pk-logo">
            <PocketLogo size={27} />
          </div>
        )}
        {!view && !scope && payload && (
          <button class={`pk-chip is-${payload.kind}`} key={payload.id} title={`${payload.detail}\n按退格键${payload.kind === "text" ? "变回文字继续编辑" : "移除"}`} onClick={editPayload}>
            {payload.preview ? <img src={payload.preview} alt="" draggable={false} /> : <Icon icon="svg:text" size={18} />}
            <span>{payload.label}</span>
          </button>
        )}
        {view ? (
          <div class="pk-view-title" key={view.feature ?? view.title}>
            <Icon icon={view.icon} size={22} />
            <span>{view.title}</span>
          </div>
        ) : (
          <input
            ref={input}
            class="pk-input"
            value={text}
            placeholder={placeholder}
            spellcheck={false}
            autocomplete="off"
            autoFocus
            onPaste={onPaste}
            onMouseDown={onInputMouseDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={(e) => {
              composing.current = false;
              const value = (e.target as HTMLInputElement).value;
              setText(value);
              runQuery(value, scope);
            }}
            onInput={(e) => {
              const value = (e.target as HTMLInputElement).value;
              setText(value);
              if (!composing.current) runQuery(value, scope);
            }}
          />
        )}
        <div class="pk-header-right">
          {(busy || view?.streaming) && <span class="pk-spinner" aria-label="正在处理" />}
          {detachable(view) && (
            <button class="pk-ghost pk-detach" title={`分离成独立窗口（${detachLabel.join(" ")}）`} onClick={detachView}>
              <PictureInPicture2 size={17} strokeWidth={1.8} />
            </button>
          )}
          <button class="pk-ghost" title={`设置（${keys.mod} ,）`} onClick={() => void Launcher.openSettings("")}>
            <SettingsIcon size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {batch.error && !view && <div class="pk-banner">配置文件有误，正在使用上一份有效配置：{batch.error}</div>}

      <div class="pk-body" ref={list}>
        {view ? (
          <div class="pk-view-enter" key={`${view.type}-${view.feature ?? view.title}-${viewNonce.current}`}>
            <ViewPane view={view} onSubmit={(args) => view.item && execute(view.item, 0, { args })} onClose={closeView} onToast={showToast} featureCtx={featureCtx} />
          </div>
        ) : isHome ? (
          <Home
            items={items}
            selected={selected}
            onSelect={select}
            onRun={(i) => execute(items[i]!.id, 0)}
            onActions={openActionsAt}
            modHeld={modHeld}
            indexLabel={keys.index}
          />
        ) : (
          <Results
            items={items}
            selected={selected}
            done={batch.done}
            onSelect={select}
            onRun={(i) => execute(items[i]!.id, 0)}
            onActions={openActionsAt}
            modHeld={modHeld}
            indexLabel={keys.index}
            showSource={!!appearance?.showSource}
            showPreview={showPreview}
            showMeta={showMeta}
          />
        )}
        {actionsOpen && current && (
          <ActionPanel key={current.id} item={current} mac={keys.mac} at={actionsAt} onRun={(index) => execute(current.id, index)} onClose={closeActions} />
        )}
      </div>

      <footer class={`pk-footer${confirm ? " is-confirm" : ""}`}>
        {confirm ? (
          <>
            <span class="pk-confirm-text">{confirm.text}</span>
            <span class="pk-keys">
              <kbd>↵</kbd> 确认 <kbd>Esc</kbd> 取消
            </span>
          </>
        ) : (
          <>
            <span class={`pk-footer-left${toast?.error ? " is-error" : ""}${toast ? " is-toast" : ""}`} key={toast?.text ?? "idle"}>
              {toast ? toast.text : view ? view.title : payload && !scope ? `已带入${payload.detail}` : (current?.sourceLabel ?? "Yojigen Pocket")}
            </span>
            <span class="pk-keys">
              {view ? (
                <>
                  {(view.type === "text" || view.type === "markdown") && (
                    <>
                      <kbd>↵</kbd> 复制全文
                    </>
                  )}
                  {view.type === "form" && (
                    <>
                      <kbd>↵</kbd> 运行
                    </>
                  )}
                  {detachable(view) && (
                    <>
                      {detachLabel.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}{" "}
                      分离窗口
                    </>
                  )}
                  <kbd>Esc</kbd> 返回
                </>
              ) : (
                <>
                  {filePanes && (
                    <span class="pk-panes">
                      <button type="button" class={appearance?.showPreview ? "is-on" : ""} title="显示或隐藏预览区" onClick={() => setPanes(!appearance?.showPreview, !!appearance?.showMeta)}>
                        预览
                      </button>
                      <button type="button" class={appearance?.showMeta ? "is-on" : ""} title="显示或隐藏属性区" onClick={() => setPanes(!!appearance?.showPreview, !appearance?.showMeta)}>
                        属性
                      </button>
                    </span>
                  )}
                  {current?.scope && (
                    <>
                      <kbd>Tab</kbd> 进入
                    </>
                  )}
                  {!current?.scope && current?.complete && (
                    <>
                      <kbd>Tab</kbd> 补全
                    </>
                  )}
                  {footerHint && (
                    <>
                      <kbd>↵</kbd> {footerHint}
                    </>
                  )}
                  {current && (
                    <>
                      <kbd>{keys.mod}</kbd>
                      <kbd>K</kbd> 更多
                    </>
                  )}
                </>
              )}
            </span>
          </>
        )}
      </footer>
    </div>
  );
}

