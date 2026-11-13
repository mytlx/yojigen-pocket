import { Trash2 } from "lucide-preact";
import type { SectionProps } from "./app";
import { Button, Section, Text, Toggle } from "./ui";

export function WebSearch({ config, update }: SectionProps) {
  return (
    <Section
      description="输入「关键词 空格 内容」直接搜索，例如 g hello。网址里的 {q} 会换成输入的内容；不含 {q} 就是网址别名。打开「兜底」后，没有匹配结果时它会出现在列表最后。"
      actions={
        <Button
          primary
          onClick={() => update((c) => c.web.push({ key: "", title: "", url: "https://", icon: "svg:globe" }))}
        >
          添加
        </Button>
      }
    >
      <div class="st-table-head st-web-grid">
        <span>关键词</span>
        <span>名称</span>
        <span>网址</span>
        <span>兜底</span>
        <span />
      </div>
      {config.web.map((e, i) => (
        <div class="st-table-row st-web-grid" key={i}>
          <Text mono value={e.key} placeholder="g" onChange={(v) => update((c) => (c.web[i]!.key = v.trim()))} />
          <Text value={e.title} placeholder="名称" onChange={(v) => update((c) => (c.web[i]!.title = v))} />
          <Text mono value={e.url} placeholder="https://example.com/search?q={q}" onChange={(v) => update((c) => (c.web[i]!.url = v.trim()))} />
          <Toggle label={`${e.title}作为兜底`} checked={!!e.fallback} onChange={(v) => update((c) => (c.web[i]!.fallback = v))} />
          <button class="st-icon-button" aria-label={`删除${e.title}`} title="删除" onClick={() => update((c) => c.web.splice(i, 1))}>
            <Trash2 size={15} strokeWidth={1.9} />
          </button>
        </div>
      ))}
      {config.web.length === 0 && <div class="st-empty">还没有条目。</div>}
    </Section>
  );
}
