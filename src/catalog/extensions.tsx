import { useEffect, useState } from "preact/hooks";
import { onFileDrop } from "mygo-runtime";
import { FolderOpen, PackagePlus, Trash2 } from "lucide-preact";
import { Extensions, events, type PluginInfo } from "../mygo";
import { Icon } from "../shared/icons";
import { Toggle } from "../features/ui";

/** 把清单里声明的权限说成人话。 */
function permissionText(p: PluginInfo): string[] {
  const out: string[] = [];
  const perm = p.permissions ?? {};
  if (perm.dirs?.length) out.push(`读写用户目录里的 ${perm.dirs.join("、")} 文件夹`);
  if (perm.fetch?.length) out.push(perm.fetch.includes("*") ? "访问任意网站" : `访问 ${perm.fetch.join("、")}`);
  if (perm.runner) out.push("运行和格式化代码");
  if (perm.peer) out.push("IPv6 直连传输：监听端口，发送所选文件并接收对方文件");
  if (perm.files) out.push("打开、另存你选择的文件");
  return out;
}

/** 扩展管理：安装（选 zip 或把 zip 拖进来）、启用停用、卸载。 */
export function ExtensionsPanel({ flash }: { flash: (text: string, error?: boolean) => void }) {
  const [list, setList] = useState<PluginInfo[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [keepData, setKeepData] = useState(true);
  const [busy, setBusy] = useState(false);
  const refresh = () => void Extensions.list().then((l) => setList(l ?? []));

  const install = (work: Promise<PluginInfo | null>) => {
    setBusy(true);
    work
      .then(
        (p) => p && flash(`已安装「${p.title}」${p.version ? ` ${p.version}` : ""}`),
        (e: Error) => flash(e.message, true),
      )
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  useEffect(() => {
    refresh();
    const offs = [
      events.resultsChanged.on(refresh),
      onFileDrop(({ paths }) => {
        const zip = paths.find((p) => p.toLowerCase().endsWith(".zip"));
        if (zip) install(Extensions.install(zip));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  return (
    <section class="ct-section">
      <div class="st-section-head">
        <div>
          <h2>扩展管理</h2>
          <p>扩展是可以单独安装和卸载的功能包。停用后它不出现在搜索里，快捷键注销，窗口和后台程序都会关掉；卸载会删掉它的文件。</p>
        </div>
        <div class="ct-ext-actions">
          <button class="ui-btn is-small q-press" onClick={() => void Extensions.reveal("")}>
            <FolderOpen size={13} /> 扩展目录
          </button>
          <button class="ui-btn is-small is-primary q-press" disabled={busy} onClick={() => install(Extensions.installDialog())}>
            <PackagePlus size={13} /> {busy ? "正在安装…" : "安装扩展…"}
          </button>
        </div>
      </div>
      {list.length === 0 && <div class="st-empty">还没有安装扩展。点右上角“安装扩展”选一个 .zip 包，或者把它拖到这个窗口里。</div>}
      <div class="ct-ext-list">
        {list.map((p) => {
          const perms = permissionText(p);
          return (
            <article key={p.id} class={`ct-ext${p.enabled ? "" : " is-off"}`}>
              <div class="ct-card-head">
                <Icon icon={p.icon} size={36} />
                <div class="ct-card-title">
                  <b>
                    {p.title} {p.version && <em class="ct-ext-version">{p.version}</em>}
                  </b>
                  <span>{p.problem || p.description || p.id}</span>
                </div>
                <Toggle checked={p.enabled} label={`${p.enabled ? "停用" : "启用"}${p.title}`} onChange={(v) => void Extensions.setEnabled(p.id, v).then(() => { flash(v ? "已启用" : "已停用，它的窗口和后台程序都关掉了"); refresh(); }, (e: Error) => flash(e.message, true))} />
              </div>
              <div class="ct-ext-meta">
                {(p.tools ?? []).length > 0 && <span>包含：{p.tools.join("、")}</span>}
                {perms.length > 0 && <span>可以：{perms.join("；")}</span>}
                {p.backend && <span class="ct-ext-warn">带有本地程序：它能做的事和你安装的任何程序一样，不受上面权限的限制。只安装信得过的来源。</span>}
                {p.problem && <span class="ct-ext-warn">{p.problem}</span>}
              </div>
              <div class="ct-actions">
                <button class="ui-btn is-small q-press" onClick={() => void Extensions.reveal(p.id)}>
                  <FolderOpen size={13} /> 文件夹
                </button>
                {confirm === p.id ? (
                  <>
                    <label class="ct-inline">
                      <input type="checkbox" checked={keepData} onChange={(e) => setKeepData((e.target as HTMLInputElement).checked)} /> 保留它存的设置
                    </label>
                    <button class="ui-btn is-small is-danger q-press" onClick={() => void Extensions.uninstall(p.id, !keepData).then(() => { setConfirm(null); flash(`已卸载「${p.title}」`); refresh(); }, (e: Error) => flash(e.message, true))}>
                      确定卸载
                    </button>
                    <button class="ui-btn is-small is-ghost" onClick={() => setConfirm(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button class="ui-btn is-small q-press" onClick={() => { setKeepData(true); setConfirm(p.id); }}>
                    <Trash2 size={13} /> 卸载
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
