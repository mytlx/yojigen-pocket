import { useEffect, useState } from "preact/hooks";
import { Catalog, Settings, type KeywordConflict, type ModuleInfo } from "../mygo";
import { Icon } from "../shared/icons";
import type { SectionProps } from "./app";
import { Button, NumberInput, Row, Section, Text, Toggle } from "./ui";

const weights = [
  { value: 0.5, label: "最低" },
  { value: 0.7, label: "较低" },
  { value: 1, label: "标准" },
  { value: 1.3, label: "较高" },
];

/** 显示离权重最近的档位。配置文件里可以写任意数值，没动过就不会被改掉。 */
function nearestWeight(value: number) {
  return weights.reduce((best, w) => (Math.abs(w.value - value) < Math.abs(best.value - value) ? w : best)).value;
}

export function Modules({ info, config, update }: SectionProps) {
  const [modules, setModules] = useState<ModuleInfo[]>([]);
  useEffect(() => {
    void Settings.modules().then(setModules);
  }, []);
  // 前缀和别的功能的关键词撞了的话，在下面提示一句。改完稍等一下（等配置保存）再查。
  const [conflicts, setConflicts] = useState<Record<string, KeywordConflict[]>>({});
  const prefixes = Object.values(config.modules).map((m) => `${m.prefix}/${m.enabled}`).join("|");
  useEffect(() => {
    const t = setTimeout(() => void Catalog.conflicts().then((c) => setConflicts(c ?? {})), 500);
    return () => clearTimeout(t);
  }, [prefixes]);

  const c = config.clipboard;
  return (
    <>
      <Section description="关掉不用的模块；前缀是这个模块的专属入口，比如输入「cb 关键词」只搜剪贴板。一个模块可以有多个前缀，用空格隔开。各个功能的关键词在道具库里改。">
        <div class="st-table-head st-modules-grid">
          <span>模块</span>
          <span>前缀</span>
          <span>全局搜索</span>
          <span>排序</span>
          <span>启用</span>
        </div>
        {modules.map((m) => {
          const mod = config.modules[m.id];
          if (!mod) return null;
          return (
            <div class={`st-table-row st-modules-grid${mod.enabled ? "" : " is-off"}`} key={m.id}>
              <div class="st-module-name">
                <Icon icon={m.icon} size={28} />
                <div>
                  <div class="st-row-label">{m.title}</div>
                  <div class="st-row-desc">{m.description}</div>
                  {(conflicts[`module:${m.id}`] ?? []).map((c) => (
                    <div class="st-row-desc st-warn-text" key={c.keyword}>
                      前缀 {c.keyword} 和「{c.with.join("」「")}」的关键词重复了
                    </div>
                  ))}
                </div>
              </div>
              <Text value={mod.prefix} mono placeholder="无" onChange={(v) => update((x) => (x.modules[m.id]!.prefix = v.trim().split(/[\s,，]+/).filter(Boolean).join(" ")))} />
              <Toggle label={`${m.title}参与全局搜索`} checked={mod.global} onChange={(v) => update((x) => (x.modules[m.id]!.global = v))} />
              <select
                class="st-select"
                aria-label={`${m.title}排序权重`}
                value={String(nearestWeight(mod.weight))}
                onChange={(e) => update((x) => (x.modules[m.id]!.weight = Number((e.target as HTMLSelectElement).value)))}
              >
                {weights.map((w) => (
                  <option key={w.value} value={String(w.value)}>
                    {w.label}
                  </option>
                ))}
              </select>
              <Toggle label={`启用${m.title}`} checked={mod.enabled} onChange={(v) => update((x) => (x.modules[m.id]!.enabled = v))} />
            </div>
          );
        })}
      </Section>

      <Section title="剪贴板历史" description="所有内容只保存在这台电脑上。带有「不要记录」标记的内容（密码管理器复制的密码）不会入库。">
        <Row label="最多保留">
          <span class="st-inline">
            <NumberInput value={c.maxItems} min={10} max={10000} onChange={(v) => update((x) => (x.clipboard.maxItems = v))} /> 条
          </span>
        </Row>
        <Row label="保留时间">
          <span class="st-inline">
            <NumberInput value={c.maxDays} min={1} max={3650} onChange={(v) => update((x) => (x.clipboard.maxDays = v))} /> 天
          </span>
        </Row>
        <Row label="记录图片">
          <Toggle label="记录图片" checked={c.images} onChange={(v) => update((x) => (x.clipboard.images = v))} />
        </Row>
        <Row label="不记录这些应用" description="逗号分隔，填应用名称">
          <Text
            width={280}
            value={c.ignoreApps.join(", ")}
            onChange={(v) => update((x) => (x.clipboard.ignoreApps = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)))}
          />
        </Row>
        <Row label="清空历史" description="固定的内容会保留">
          <Button danger onClick={() => void Settings.clearClipboard()}>清空</Button>
        </Row>
      </Section>

      <Section
        title="文件搜索"
        description={
          info.platform === "windows"
            ? "优先使用 Everything（需要安装 Everything 和 ES 命令行工具 es.exe），支持它的全部搜索语法。没有安装时，只搜下面这些目录。"
            : "使用系统的 Spotlight 搜索。"
        }
      >
        {info.platform === "windows" && (
          <Row label="es.exe 路径" description="留空自动查找">
            <Text width={280} mono value={config.files.everythingPath ?? ""} placeholder="自动" onChange={(v) => update((x) => (x.files.everythingPath = v))} />
          </Row>
        )}
        <Row label={info.platform === "windows" ? "备用搜索目录" : "Spotlight 不可用时搜索的目录"} description="逗号分隔">
          <Text
            width={280}
            mono
            value={config.files.roots.join(", ")}
            onChange={(v) => update((x) => (x.files.roots = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean)))}
          />
        </Row>
      </Section>
    </>
  );
}
