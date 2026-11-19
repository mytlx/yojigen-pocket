import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { onFileDrop } from "mygo-runtime";
import { ArrowUpCircle, ChevronDown, ChevronUp, Download, FolderOpen, PackagePlus, RefreshCw, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-preact";
import {
  Extensions,
  events,
  type BatchInstallResult,
  type Permissions,
  type PluginInfo,
  type StoreExtension,
  type StoreResult,
} from "../mygo";
import { Icon } from "../shared/icons";
import { formatLocalTime } from "../shared/time";
import { Toggle } from "../features/ui";

/** 把清单里声明的权限说成人话。 */
function permissionText(perm?: Permissions): string[] {
  const out: string[] = [];
  if (!perm) return out;
  if (perm.dirs?.length) out.push(`读写用户目录里的 ${perm.dirs.join("、")} 文件夹`);
  if (perm.fetch?.length) out.push(perm.fetch.includes("*") ? "访问任意网站" : `访问 ${perm.fetch.join("、")}`);
  if (perm.runner) out.push("运行和格式化代码");
  if (perm.peer) out.push("点对点直传：监听端口与 UDP 打洞，发送所选文件并接收对方文件");
  if (perm.files) out.push("打开、另存你选择的文件");
  return out;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchesQuery(query: string, fields: Array<string | string[] | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) =>
    Array.isArray(f) ? f.some((x) => x.toLowerCase().includes(q)) : (f ?? "").toLowerCase().includes(q),
  );
}

function summarizeBatch(res: BatchInstallResult | null | undefined, action: string, flash: (text: string, error?: boolean) => void) {
  if (!res) return;
  const ok = res.installed ?? [];
  const failed = res.failed ?? [];
  if (ok.length === 0 && failed.length === 0) return;

  const okNames = ok.map((p) => `${p.title}${p.version ? ` ${p.version}` : ""}`).join("、");
  if (failed.length === 0) {
    if (ok.length === 1) {
      const first = ok[0]!;
      flash(`已${action}「${first.title}」${first.version ? ` ${first.version}` : ""}`);
    } else {
      flash(`已${action} ${ok.length} 个扩展：${okNames}`);
    }
    return;
  }

  const failSummary = failed.map((f) => `${f.name || f.source}：${f.error}`).join("；");
  if (ok.length > 0) {
    flash(`已${action} ${ok.length} 个扩展；${failed.length} 个失败（${failSummary}）`, true);
  } else {
    flash(`${action}失败：${failSummary}`, true);
  }
}

/** 扩展管理 + 官方扩展商店：批量拖入安装、启用停用、卸载，以及在线获取和升级官方扩展。 */
export function ExtensionsPanel({ flash, query = "" }: { flash: (text: string, error?: boolean) => void; query?: string }) {
  const [list, setList] = useState<PluginInfo[]>([]);
  const [store, setStore] = useState<StoreResult | null>(null);
  const [loadingStore, setLoadingStore] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [keepData, setKeepData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeRemoteID, setActiveRemoteID] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [showSource, setShowSource] = useState(false);
  const [registryInput, setRegistryInput] = useState("");
  const [mirrorInput, setMirrorInput] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const mounted = useRef(true);

  const refreshInstalled = () => void Extensions.list().then((l) => mounted.current && setList(l ?? []));

  const loadStore = async (refresh: boolean, silent = false) => {
    setLoadingStore(true);
    try {
      const res = await Extensions.store(refresh);
      if (!mounted.current) return null;
      setStore(res);
      if (!silent && res.error && (!res.items || res.items.length === 0)) {
        flash(`检查更新失败：${res.error}`, true);
      }
      return res;
    } catch (e) {
      if (!silent && mounted.current) flash((e as Error).message, true);
      return null;
    } finally {
      if (mounted.current) setLoadingStore(false);
    }
  };

  const runBatchInstall = (work: Promise<BatchInstallResult | null>, verb = "安装") => {
    setBusy(true);
    work
      .then(
        (res) => summarizeBatch(res, verb, flash),
        (e: Error) => flash(e.message, true),
      )
      .finally(() => {
        if (!mounted.current) return;
        setBusy(false);
        refreshInstalled();
        void loadStore(false, true);
      });
  };

  useEffect(() => {
    mounted.current = true;
    refreshInstalled();
    void loadStore(false, true).then((res) => {
      if (mounted.current && res?.fromCache) {
        void loadStore(true, true);
      }
    });

    const offs = [
      events.resultsChanged.on(refreshInstalled),
      onFileDrop(({ paths }) => {
        if (!paths?.length) return;
        const zips = Array.from(new Set(paths.filter((p) => p.toLowerCase().endsWith(".zip"))));
        if (zips.length === 0) {
          flash("请拖入 .zip 格式的扩展包", true);
          return;
        }
        runBatchInstall(Extensions.installMany(zips));
      }),
    ];
    return () => {
      mounted.current = false;
      offs.forEach((off) => off());
    };
  }, []);

  const storeByID = useMemo(() => {
    const map = new Map<string, StoreExtension>();
    for (const it of store?.items ?? []) map.set(it.id, it);
    return map;
  }, [store]);

  const updatable = useMemo(
    () => (store?.items ?? []).filter((it) => it.status === "update_available"),
    [store],
  );

  const visibleInstalled = useMemo(
    () => list.filter((p) => matchesQuery(query, [p.title, p.id, p.description, p.tools])),
    [list, query],
  );

  const availableRemote = useMemo(() => {
    const installedIDs = new Set(list.map((p) => p.id));
    return (store?.items ?? []).filter(
      (it) => !installedIDs.has(it.id) && matchesQuery(query, [it.name, it.id, it.description, it.tools]),
    );
  }, [store, list, query]);

  const toggleLog = (key: string) => setExpandedLogs((prev) => ({ ...prev, [key]: !prev[key] }));

  const installRemoteOne = (item: StoreExtension, verb: "安装" | "更新") => {
    setActiveRemoteID(item.id);
    Extensions.installRemote(item.id)
      .then(
        (p) => p && flash(`已${verb}「${p.title}」${p.version ? ` ${p.version}` : ""}`),
        (e: Error) => flash(e.message, true),
      )
      .finally(() => {
        if (!mounted.current) return;
        setActiveRemoteID(null);
        refreshInstalled();
        void loadStore(false, true);
      });
  };

  const updateAllRemote = () => {
    setActiveRemoteID("__all__");
    Extensions.updateAll()
      .then(
        (res) => summarizeBatch(res, "更新", flash),
        (e: Error) => flash(e.message, true),
      )
      .finally(() => {
        if (!mounted.current) return;
        setActiveRemoteID(null);
        refreshInstalled();
        void loadStore(false, true);
      });
  };

  const saveSourceConfig = () => {
    setSavingSource(true);
    Extensions.saveStoreConfig({ registryUrl: registryInput, mirrorUrl: mirrorInput })
      .then(
        (saved) => {
          setRegistryInput(saved.registryUrl);
          setMirrorInput(saved.mirrorUrl);
          flash("扩展源设置已保存");
          return loadStore(true);
        },
        (e: Error) => flash(e.message, true),
      )
      .finally(() => {
        if (mounted.current) setSavingSource(false);
      });
  };

  const toggleSourcePanel = () => {
    if (!showSource) {
      if (store) {
        setRegistryInput(store.registryUrl ?? "");
        setMirrorInput(store.mirrorUrl ?? "");
      } else {
        void Extensions.storeConfig().then((cfg) => {
          if (!mounted.current) return;
          setRegistryInput(cfg.registryUrl ?? "");
          setMirrorInput(cfg.mirrorUrl ?? "");
        });
      }
    }
    setShowSource((v) => !v);
  };

  const remoteBusy = activeRemoteID !== null;

  return (
    <>
      <section class="ct-section">
        <div class="st-section-head">
          <div>
            <h2>扩展管理</h2>
            <p>支持批量选择或拖入多个 .zip 扩展包，也可从下方官方扩展商店一键安装与更新。停用或卸载会关掉它的窗口与后台程序。</p>
          </div>
          <div class="ct-ext-actions">
            <button class="ui-btn is-small q-press" disabled={loadingStore || remoteBusy} onClick={() => void loadStore(true)}>
              <RefreshCw size={13} class={loadingStore ? "ct-spin" : ""} /> {loadingStore ? "检查中…" : "检查更新"}
            </button>
            <button class={`ui-btn is-small q-press${showSource ? " is-on" : ""}`} onClick={toggleSourcePanel}>
              <SlidersHorizontal size={13} /> 下载源
            </button>
            <button class="ui-btn is-small q-press" onClick={() => void Extensions.reveal("")}>
              <FolderOpen size={13} /> 扩展目录
            </button>
            <button class="ui-btn is-small is-primary q-press" disabled={busy || remoteBusy} onClick={() => runBatchInstall(Extensions.installDialogMany())}>
              <PackagePlus size={13} /> {busy ? "正在安装…" : "安装扩展…"}
            </button>
          </div>
        </div>

        {showSource && (
          <div class="ct-ext-source">
            <div class="ct-ext-source-row">
              <label>加速镜像（可选）</label>
              <input
                class="ui-input is-mono"
                placeholder="例如 https://gh-proxy.com/（留空直连 GitHub，失败自动回退直连）"
                value={mirrorInput}
                onInput={(e) => setMirrorInput((e.target as HTMLInputElement).value)}
                spellcheck={false}
              />
              {mirrorInput && (
                <button class="ui-btn is-small q-press" onClick={() => setMirrorInput("")}>清空</button>
              )}
            </div>
            <div class="ct-ext-source-row">
              <label>扩展源索引</label>
              <input
                class="ui-input is-mono"
                placeholder={store?.defaultUrl || "默认官方扩展索引地址"}
                value={registryInput}
                onInput={(e) => setRegistryInput((e.target as HTMLInputElement).value)}
                spellcheck={false}
              />
              {registryInput && (
                <button class="ui-btn is-small q-press" onClick={() => setRegistryInput("")}>恢复默认</button>
              )}
            </div>
            <div class="ct-ext-source-foot">
              <span>所有远程包均强制校验 SHA-256 哈希与路径安全，第三方镜像无法篡改内容。</span>
              <button class="ui-btn is-small is-primary q-press" disabled={savingSource} onClick={saveSourceConfig}>
                {savingSource ? "保存中…" : "保存并刷新"}
              </button>
            </div>
          </div>
        )}

        {updatable.length > 0 && (
          <div class="ct-ext-update-bar">
            <ArrowUpCircle size={15} />
            <span>
              发现 {updatable.length} 个扩展可更新：{updatable.map((u) => `${u.name} (${u.installedVersion || "?"} → ${u.installableVersion})`).join("、")}
            </span>
            <button class="ui-btn is-small is-primary q-press" disabled={busy || remoteBusy} onClick={updateAllRemote}>
              <Download size={13} /> {activeRemoteID === "__all__" ? "正在更新…" : "全部更新"}
            </button>
          </div>
        )}

        {list.length === 0 && !query.trim() && (
          <div class="st-empty">还没有安装扩展。可以直接在下方商店点击安装，或点右上角“安装扩展”、将多个 .zip 包直接拖进此窗口。</div>
        )}
        {list.length > 0 && visibleInstalled.length === 0 && (
          <div class="st-empty">已安装扩展中没有匹配“{query}”的结果</div>
        )}

        <div class="ct-ext-list">
          {visibleInstalled.map((p) => {
            const perms = permissionText(p.permissions);
            const remote = storeByID.get(p.id);
            const hasUpdate = remote?.status === "update_available";
            const isUpdating = activeRemoteID === p.id || (activeRemoteID === "__all__" && hasUpdate);
            const logOpen = !!expandedLogs[`inst:${p.id}`];

            return (
              <article key={p.id} class={`ct-ext${p.enabled ? "" : " is-off"}`}>
                <div class="ct-card-head">
                  <Icon icon={p.icon} size={36} />
                  <div class="ct-card-title">
                    <b>
                      {p.title} {p.version && <em class="ct-ext-version">{p.version}</em>}
                      {hasUpdate && (
                        <em class="ct-ext-badge is-update">
                          可更新至 {remote.installableVersion}{remote.size ? ` · ${formatSize(remote.size)}` : ""}
                        </em>
                      )}
                      {remote?.requiresAppUpdate && (
                        <em class="ct-ext-badge is-warn">有新版 {remote.latestVersion}（需升级主程序）</em>
                      )}
                    </b>
                    <span>{p.problem || p.description || p.id}</span>
                  </div>
                  <Toggle
                    checked={p.enabled}
                    label={`${p.enabled ? "停用" : "启用"}${p.title}`}
                    onChange={(v) =>
                      void Extensions.setEnabled(p.id, v).then(
                        () => {
                          flash(v ? "已启用" : "已停用，它的窗口和后台程序都关掉了");
                          refreshInstalled();
                        },
                        (e: Error) => flash(e.message, true),
                      )
                    }
                  />
                </div>
                <div class="ct-ext-meta">
                  {(p.tools ?? []).length > 0 && <span>包含：{p.tools.join("、")}</span>}
                  {perms.length > 0 && <span>可以：{perms.join("；")}</span>}
                  {remote?.publishedAt && (
                    <span title={remote.publishedAt}>
                      {hasUpdate ? "最新版本发布于：" : "商店最新发布："}
                      {formatLocalTime(remote.publishedAt)}
                    </span>
                  )}
                  {p.backend && <span class="ct-ext-warn">带有本地程序：它能做的事和你安装的任何程序一样，不受上面权限的限制。只安装信得过的来源。</span>}
                  {p.problem && <span class="ct-ext-warn">{p.problem}</span>}
                </div>
                {hasUpdate && remote.changelog && logOpen && (
                  <pre class="ct-ext-changelog">{remote.changelog}</pre>
                )}
                <div class="ct-actions">
                  {hasUpdate && (
                    <button class="ui-btn is-small is-primary q-press" disabled={busy || remoteBusy} onClick={() => installRemoteOne(remote, "更新")}>
                      <Download size={13} /> {isUpdating ? "更新中…" : `更新到 ${remote.installableVersion}`}
                    </button>
                  )}
                  {hasUpdate && remote.changelog && (
                    <button class="ui-btn is-small q-press" onClick={() => toggleLog(`inst:${p.id}`)}>
                      {logOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />} 更新日志
                    </button>
                  )}
                  <button class="ui-btn is-small q-press" onClick={() => void Extensions.reveal(p.id)}>
                    <FolderOpen size={13} /> 文件夹
                  </button>
                  {confirm === p.id ? (
                    <>
                      <label class="ct-inline">
                        <input type="checkbox" checked={keepData} onChange={(e) => setKeepData((e.target as HTMLInputElement).checked)} /> 保留它存的设置
                      </label>
                      <button
                        class="ui-btn is-small is-danger q-press"
                        onClick={() =>
                          void Extensions.uninstall(p.id, !keepData).then(
                            () => {
                              setConfirm(null);
                              flash(`已卸载「${p.title}」`);
                              refreshInstalled();
                              void loadStore(false, true);
                            },
                            (e: Error) => flash(e.message, true),
                          )
                        }
                      >
                        确定卸载
                      </button>
                      <button class="ui-btn is-small is-ghost" onClick={() => setConfirm(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button class="ui-btn is-small q-press" disabled={isUpdating} onClick={() => { setKeepData(true); setConfirm(p.id); }}>
                      <Trash2 size={13} /> 卸载
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section class="ct-section">
        <div class="st-section-head">
          <div>
            <h2>官方扩展商店</h2>
            <p>
              在线获取内置生态扩展，下载时自动校验 SHA-256。
              {store?.updatedAt && (
                <span title={store.updatedAt}>
                  {` 最近索引更新时间：${formatLocalTime(store.updatedAt)}`}
                </span>
              )}
            </p>
          </div>
          <button class="ui-btn is-small q-press" disabled={loadingStore || remoteBusy} onClick={() => void loadStore(true)}>
            <RefreshCw size={13} class={loadingStore ? "ct-spin" : ""} /> {loadingStore ? "刷新中…" : "刷新索引"}
          </button>
        </div>

        {store?.error && (
          <div class="ct-conflict-bar">
            <TriangleAlert size={15} />
            <span>{store.items?.length ? `刷新在线索引失败（当前显示本地缓存）：${store.error}` : `获取官方扩展清单失败：${store.error}`}</span>
            <button class="ui-btn is-small q-press" disabled={loadingStore} onClick={() => void loadStore(true)}>重试</button>
          </div>
        )}

        {!store && loadingStore && <div class="st-empty">正在获取官方扩展商店…</div>}

        {store && !store.error && availableRemote.length === 0 && (
          <div class="st-empty">
            {query.trim() ? `商店里没有匹配“${query}”的未安装扩展` : "全部官方扩展都已安装"}
          </div>
        )}

        <div class="ct-ext-list">
          {availableRemote.map((item) => {
            const perms = permissionText(item.permissions);
            const versionLabel = item.installableVersion || item.latestVersion;
            const incompatible = item.status === "incompatible";
            const isInstalling = activeRemoteID === item.id;
            const logOpen = !!expandedLogs[`store:${item.id}`];

            return (
              <article key={item.id} class="ct-ext">
                <div class="ct-card-head">
                  <Icon icon={item.icon} size={36} />
                  <div class="ct-card-title">
                    <b>
                      {item.name} {versionLabel && <em class="ct-ext-version">{versionLabel}</em>}
                      {item.size ? <em class="ct-ext-version"> · {formatSize(item.size)}</em> : null}
                      {incompatible && (
                        <em class="ct-ext-badge is-warn">需要接口 API v{item.latestApi}（当前 v{store?.hostApi ?? 2}）</em>
                      )}
                    </b>
                    <span>{item.description || item.id}</span>
                  </div>
                  <button
                    class="ui-btn is-small is-primary q-press"
                    disabled={incompatible || busy || remoteBusy}
                    onClick={() => installRemoteOne(item, "安装")}
                  >
                    <Download size={13} /> {incompatible ? "需升级应用" : isInstalling ? "安装中…" : "安装"}
                  </button>
                </div>
                <div class="ct-ext-meta">
                  {(item.tools ?? []).length > 0 && <span>包含：{item.tools!.join("、")}</span>}
                  {perms.length > 0 && <span>需要权限：{perms.join("；")}</span>}
                  {item.publishedAt && (
                    <span title={item.publishedAt}>发布时间：{formatLocalTime(item.publishedAt)}</span>
                  )}
                  {item.backend && <span class="ct-ext-warn">带有本地程序：它能做的事和你安装的任何程序一样，不受上面权限的限制。</span>}
                </div>
                {item.changelog && logOpen && (
                  <pre class="ct-ext-changelog">{item.changelog}</pre>
                )}
                {item.changelog && (
                  <div class="ct-actions">
                    <button class="ui-btn is-small q-press" onClick={() => toggleLog(`store:${item.id}`)}>
                      {logOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />} 更新日志
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
