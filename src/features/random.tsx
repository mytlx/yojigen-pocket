import { useCallback, useEffect, useState } from "preact/hooks";
import { RefreshCw } from "lucide-preact";
import { Btn, CopyBtn, Seg, Toggle } from "./ui";
import type { FeatureProps } from "./types";

const sets = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?",
};
const similar = /[il1Lo0O]/g;

function randomInt(max: number) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}

export function RandomTool({ args, ctx }: FeatureProps) {
  const [tab, setTab] = useState<"uuid" | "password">(args.tab === "password" ? "password" : "uuid");
  const [count, setCount] = useState(5);
  const [upper, setUpper] = useState(false);
  const [hyphen, setHyphen] = useState(true);
  const [length, setLength] = useState(20);
  const [use, setUse] = useState({ lower: true, upper: true, digits: true, symbols: true });
  const [noSimilar, setNoSimilar] = useState(true);
  const [list, setList] = useState<string[]>([]);
  const [gen, setGen] = useState(0);

  const generate = useCallback(() => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      if (tab === "uuid") {
        let u: string = crypto.randomUUID();
        if (!hyphen) u = u.replace(/-/g, "");
        out.push(upper ? u.toUpperCase() : u);
      } else {
        let chars = Object.entries(use)
          .filter(([, on]) => on)
          .map(([k]) => sets[k as keyof typeof sets])
          .join("");
        if (noSimilar) chars = chars.replace(similar, "");
        if (!chars) chars = sets.lower;
        out.push(Array.from({ length }, () => chars[randomInt(chars.length)]).join(""));
      }
    }
    setList(out);
    setGen((g) => g + 1);
  }, [tab, count, upper, hyphen, length, use, noSimilar]);
  useEffect(generate, [generate]);

  return (
    <div class="fx-page">
      <div class="fx-toolbar">
        <Seg value={tab} onChange={setTab} options={[{ value: "uuid", label: "UUID" }, { value: "password", label: "随机密码" }]} />
        <span class="fx-spacer" />
        <label class="fx-inline">
          数量
          <input class="ui-input fx-num-input" type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.min(50, Math.max(1, Number((e.target as HTMLInputElement).value))))} />
        </label>
        <Btn small primary onClick={generate}>
          <RefreshCw size={14} /> 重新生成
        </Btn>
      </div>
      <div class="fx-toolbar fx-options">
        {tab === "uuid" ? (
          <>
            <label class="fx-inline">
              大写 <Toggle checked={upper} onChange={setUpper} />
            </label>
            <label class="fx-inline">
              带连字符 <Toggle checked={hyphen} onChange={setHyphen} />
            </label>
          </>
        ) : (
          <>
            <label class="fx-inline">
              长度
              <input class="ui-input fx-num-input" type="number" min={4} max={128} value={length} onChange={(e) => setLength(Math.min(128, Math.max(4, Number((e.target as HTMLInputElement).value))))} />
            </label>
            {(Object.keys(sets) as (keyof typeof sets)[]).map((k) => (
              <Btn key={k} small on={use[k]} onClick={() => setUse({ ...use, [k]: !use[k] })}>
                {{ lower: "小写", upper: "大写", digits: "数字", symbols: "符号" }[k]}
              </Btn>
            ))}
            <Btn small on={noSimilar} onClick={() => setNoSimilar(!noSimilar)} title="去掉 i l 1 L o 0 O">
              去掉易混字符
            </Btn>
          </>
        )}
      </div>
      <div class="fx-rows fx-grow-1 fx-scroll" key={gen}>
        {list.map((v, i) => (
          <div class="fx-kv fx-stagger" style={{ animationDelay: `${i * 22}ms` }} key={i}>
            <code class="fx-kv-val">{v}</code>
            <CopyBtn text={v} copy={ctx.copy} />
          </div>
        ))}
      </div>
      <div class="fx-toolbar">
        <span class="fx-spacer" />
        <CopyBtn text={list.join("\n")} copy={ctx.copy} label="全部复制" />
      </div>
    </div>
  );
}
