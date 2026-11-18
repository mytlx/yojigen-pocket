import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Launcher, type View } from "../mygo";
import { renderMarkdown } from "../shared/markdown";
import { features } from "../features/registry";
import type { FeatureCtx } from "../features/types";
import { PluginFrame, type PluginHostHooks } from "../shared/pluginframe";

export type ActiveView = View & { streaming?: boolean };

export function ViewPane({ view, onSubmit, onClose, onToast, featureCtx }: {
  view: ActiveView;
  onSubmit: (args: Record<string, string>) => void;
  onClose: () => void;
  onToast: (text: string, error?: boolean) => void;
  featureCtx: FeatureCtx;
}) {
  switch (view.type) {
    case "feature":
      return <FeatureHost view={view} ctx={featureCtx} />;
    case "text":
    case "markdown":
      return <DocumentView view={view} onToast={onToast} />;
    case "form":
      return <FormView view={view} onSubmit={onSubmit} />;
    case "panel":
      return <PanelView view={view} onClose={onClose} hooks={{ toast: onToast, detach: featureCtx.detach, remember: featureCtx.remember }} detachKey={featureCtx.detachKey} />;
  }
  return null;
}

/** 文本和 Markdown 视图：内容流式追加，回车复制全文。 */
function DocumentView({ view, onToast }: { view: ActiveView; onToast: (text: string, error?: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  // 正在流式输出时，停留在底部就继续跟随。
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current && view.streaming) el.scrollTop = el.scrollHeight;
  }, [view.content, view.streaming]);

  return (
    <div
      ref={box}
      class="pk-document"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void Launcher.copyText(view.content ?? "").then(() => onToast("已复制全文"));
        }
      }}
    >
      {view.type === "markdown" ? (
        <div
          class="pk-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(view.content ?? "") }}
          onClick={(e) => {
            const link = (e.target as HTMLElement).closest("a");
            if (link) {
              e.preventDefault();
              void Launcher.openExternal(link.href);
            }
          }}
        />
      ) : (
        <pre class="pk-text">{view.content || (view.streaming ? "" : "（没有输出）")}</pre>
      )}
    </div>
  );
}

/** 表单视图：脚本声明的参数。 */
function FormView({ view, onSubmit }: { view: ActiveView; onSubmit: (args: Record<string, string>) => void }) {
  const fields = view.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.default ?? (f.type === "dropdown" ? (f.options?.[0] ?? "") : "")])),
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input,select")?.focus();
  }, []);

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  return (
    <form
      ref={form}
      class="pk-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values);
      }}
    >
      {fields.map((f) => (
        <label class="pk-field" key={f.name}>
          <span>
            {f.label || f.name}
            {f.optional && <em>可选</em>}
          </span>
          {f.type === "dropdown" ? (
            <select value={values[f.name]} onChange={(e) => set(f.name, (e.target as HTMLSelectElement).value)}>
              {(f.options ?? []).map((o) => (
                <option value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <div class="pk-field-row">
              <input
                type={f.type === "password" ? "password" : "text"}
                value={values[f.name]}
                placeholder={f.placeholder}
                required={!f.optional}
                spellcheck={false}
                onInput={(e) => set(f.name, (e.target as HTMLInputElement).value)}
              />
              {f.type === "file" && (
                <button
                  type="button"
                  onClick={() => void Launcher.pickFile().then((p) => p && set(f.name, p))}
                >
                  选择…
                </button>
              )}
            </div>
          )}
        </label>
      ))}
      <button class="pk-form-submit" type="submit">
        运行
      </button>
    </form>
  );
}

/** 内置功能页。在主窗口里给一个固定高度，里面的内容自己排版。 */
export function FeatureHost({ view, ctx, fill }: { view: ActiveView; ctx: FeatureCtx; fill?: boolean }) {
  const f = features[view.feature ?? ""];
  if (!f) return <div class="pk-empty">没有这个功能：{view.feature}</div>;
  const Component = f.component;
  return (
    <div class="pk-feature" style={fill ? undefined : { height: `${f.height}px` }}>
      <Component input={view.input ?? ""} args={view.args ?? {}} ctx={ctx} />
    </div>
  );
}

/** 网页面板：扩展和 panel 模式的脚本。运行在 iframe 里，和主页面隔离。 */
export function PanelView({ view, onClose, fill, hooks, detached, detachKey }: { view: ActiveView; onClose: () => void; fill?: boolean; hooks?: PluginHostHooks; detached?: boolean; detachKey?: string }) {
  const height = view.height && view.height > 0 ? view.height : 460;
  return (
    <PluginFrame
      plugin={view.plugin}
      tool={view.args?.tool}
      url={view.url}
      html={view.html}
      title={view.title}
      input={view.input}
      args={view.args}
      detached={detached}
      detachKey={detachKey}
      onClose={onClose}
      style={fill ? { height: "100%" } : { height: `${height}px` }}
      {...hooks}
    />
  );
}
