import { useEffect, useState } from "preact/hooks";
import { Settings, events, type Snippet } from "../mygo";
import { Button } from "./ui";

/** 文本片段：左边列表，右边编辑。对应 snippets 目录下的文件。 */
export function Snippets() {
  const [list, setList] = useState<Snippet[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const refresh = async () => {
    const items = await Settings.snippets();
    setList(items);
    return items;
  };
  useEffect(() => {
    void refresh().then((items) => {
      if (items[0]) open(items[0]);
    });
    return events.resultsChanged.on(() => void refresh());
  }, []);

  const open = (s: Snippet) => {
    setActive(s.name);
    setName(s.name);
    setBody(s.body);
    setError("");
    setSaved(false);
  };

  const create = () => {
    setActive("");
    setName("");
    setBody("");
    setError("");
    setSaved(false);
  };

  const save = async () => {
    try {
      await Settings.saveSnippet(active ?? "", name, body);
      setActive(name.trim());
      setError("");
      setSaved(true);
      await refresh();
    } catch (err) {
      setSaved(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (!active) return;
    await Settings.deleteSnippet(active);
    const items = await refresh();
    if (items[0]) open(items[0]);
    else {
      setActive(null);
      setName("");
      setBody("");
    }
  };

  return (
    <div class="st-snippets">
      <div class="st-snippet-list st-card">
        <div class="st-snippet-toolbar">
          <Button primary onClick={create}>新建</Button>
          <Button onClick={() => void Settings.openFolder("snippets")}>打开目录</Button>
        </div>
        <div class="st-snippet-items">
          {list.map((s) => (
            <button key={s.name} class={`st-snippet${s.name === active ? " is-active" : ""}`} onClick={() => open(s)}>
              {s.name}
            </button>
          ))}
          {list.length === 0 && <div class="st-empty">还没有片段。</div>}
        </div>
      </div>
      <div class="st-snippet-editor st-card">
        {active === null ? (
          <div class="st-empty">选择或新建一个片段。</div>
        ) : (
          <>
            <input
              class="st-snippet-name"
              value={name}
              placeholder="片段名称，也是搜索用的标题"
              spellcheck={false}
              onInput={(e) => {
                setName((e.target as HTMLInputElement).value);
                setSaved(false);
              }}
            />
            <textarea
              class="st-snippet-body"
              value={body}
              placeholder="片段内容"
              spellcheck={false}
              onInput={(e) => {
                setBody((e.target as HTMLTextAreaElement).value);
                setSaved(false);
              }}
            />
            <div class="st-snippet-foot">
              <span class={error ? "st-row-error" : "st-row-desc"}>
                {error || (saved ? "已保存" : "可用变量：{date} {time} {datetime} {clipboard} {uuid}")}
              </span>
              <span class="st-inline">
                {active && <Button danger onClick={() => void remove()}>删除</Button>}
                <Button primary onClick={() => void save()}>保存</Button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
