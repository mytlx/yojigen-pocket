import { useEffect, useState } from "preact/hooks";
import { Settings } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Row, Section, Segmented, Slider, Toggle } from "./ui";
import { Check } from "lucide-preact";

const accents = ["#2f6bff", "#6d5cff", "#e5484d", "#f76b15", "#16a34a", "#0ea5a4", "#d6409f", "#475569"];

export function Appearance({ view, info, config, update }: SectionProps) {
  const a = config.appearance;
  const set = (fn: (x: typeof a) => void) => update((c) => fn(c.appearance));
  const glass = info.glassSupported;
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => () => void Settings.previewPanel(false), []);

  return (
    <>
      <Section>
        <Row label="主题">
          <Segmented
            value={a.theme as "system" | "light" | "dark"}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(v) => set((x) => (x.theme = v))}
          />
        </Row>
        <Row label="强调色" description="选中行、高亮文字和按钮的颜色">
          <div class="st-swatches">
            {accents.map((color) => (
              <button
                key={color}
                class="st-swatch"
                style={{ background: color }}
                aria-label={color}
                aria-pressed={a.accent === color}
                onClick={() => set((x) => (x.accent = color))}
              >
                {a.accent === color && <Check size={13} strokeWidth={3} color="#fff" />}
              </button>
            ))}
            <label class={`st-swatch st-swatch-custom${!accents.includes(a.accent) && a.accent !== "system" ? " is-on" : ""}`} title="自定义颜色">
              <input type="color" value={a.accent === "system" ? (view.systemAccent ?? "#2f6bff") : a.accent} onInput={(e) => set((x) => (x.accent = (e.target as HTMLInputElement).value))} />
            </label>
            {view.systemAccent && (
              <button class={`st-chip${a.accent === "system" ? " is-on" : ""}`} onClick={() => set((x) => (x.accent = "system"))}>
                跟随系统
              </button>
            )}
          </div>
        </Row>
      </Section>

      <Section title="玻璃" description={glass ? "材质由系统绘制：macOS 26 是液态玻璃，更早的 macOS 是毛玻璃，Windows 11 是亚克力。" : "这台电脑的系统不支持窗口材质（需要 Windows 11 22H2 或更新版本），界面使用不透明的底色。"}>
        <Row label="材质">
          <Segmented
            value={a.material as "glass" | "clear" | "hud" | "none"}
            options={[
              { value: "glass", label: "玻璃" },
              { value: "clear", label: "通透" },
              { value: "hud", label: "深邃" },
              { value: "none", label: "不透明" },
            ]}
            onChange={(v) => set((x) => (x.material = v))}
          />
        </Row>
        <Row label="底色浓度" description="越高文字越清晰，越低越通透">
          <Slider value={a.tint} min={0} max={100} unit="%" onChange={(v) => set((x) => (x.tint = v))} />
        </Row>
        <Row label="看看效果" description="把主窗口打开，边调边看">
          <Button
            onClick={() => {
              void Settings.previewPanel(!previewing);
              setPreviewing(!previewing);
            }}
          >
            {previewing ? "收起主窗口" : "预览主窗口"}
          </Button>
        </Row>
      </Section>

      <Section title="布局">
        <Row label="窗口宽度">
          <Slider value={a.width} min={520} max={1200} step={20} unit=" px" onChange={(v) => set((x) => (x.width = v))} />
        </Row>
        <Row label="可见行数" description="超出后滚动">
          <Slider value={a.rows} min={4} max={14} unit=" 行" onChange={(v) => set((x) => (x.rows = v))} />
        </Row>
        <Row label="行高">
          <Segmented
            value={a.density as "compact" | "normal" | "comfortable"}
            options={[
              { value: "compact", label: "紧凑" },
              { value: "normal", label: "标准" },
              { value: "comfortable", label: "宽松" },
            ]}
            onChange={(v) => set((x) => (x.density = v))}
          />
        </Row>
        <Row label="字号">
          <Slider value={a.fontSize} min={12} max={18} unit=" px" onChange={(v) => set((x) => (x.fontSize = v))} />
        </Row>
        <Row label="显示来源标记" description="结果行右侧的「应用」「文件」等文字">
          <Toggle label="显示来源标记" checked={a.showSource} onChange={(v) => set((x) => (x.showSource = v))} />
        </Row>
        <Row label="显示预览" description="选中文件、剪贴板内容时，在右侧显示预览">
          <Toggle label="显示预览" checked={a.showPreview} onChange={(v) => set((x) => (x.showPreview = v))} />
        </Row>
        <Row label="显示文件属性" description="选中文件时，在右侧显示类型、大小、时间等属性。选中文件后也可以在窗口底部随手开关">
          <Toggle label="显示文件属性" checked={a.showMeta} onChange={(v) => set((x) => (x.showMeta = v))} />
        </Row>
      </Section>

      <Section title="深度定制" description="保存后立刻生效，不需要重启。">
        <Row label="theme.css" description="只改配色、字体、圆角等变量">
          <Button onClick={() => void Settings.editUserFile("theme.css")}>编辑</Button>
        </Row>
        <Row label="user.css" description="覆盖任意样式">
          <Button onClick={() => void Settings.editUserFile("user.css")}>编辑</Button>
        </Row>
        <Row label="user.js" description="界面钩子：改写输入、调整排序、添加快捷键">
          <Button onClick={() => void Settings.editUserFile("user.js")}>编辑</Button>
        </Row>
      </Section>
    </>
  );
}
