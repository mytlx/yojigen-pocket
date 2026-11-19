import { useEffect, useState } from "preact/hooks";
import { Check, Clock, Image as ImageIcon, Keyboard, LayoutPanelLeft, Palette, Pipette, RotateCcw, Upload, X } from "lucide-preact";
import { Btn } from "../../../../src/features/ui";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  MAX_HIGHLIGHT_HISTORY,
  highlightSwatchHex,
  normalizeHexColor,
  resolveHighlightVars,
  type HighlightColorId,
} from "./highlights";
import {
  defaultImagePrefs,
  resolveImageDir,
  uploadImageToHost,
  type ImagePrefs,
  type ImageRenameMode,
} from "./images";
import {
  SHORTCUT_GROUPS,
  SHORTCUT_ITEMS,
  defaultShortcuts,
  findShortcutConflicts,
  shortcutOf,
  type NoteShortcuts,
  type ShortcutActionId,
} from "./shortcuts";
import { DEFAULT_OUTLINE_BOUNDS, DEFAULT_SIDEBAR_BOUNDS, type PanelBounds } from "./sidebar";
import { DEFAULT_TIME_FORMAT, TIME_FORMAT_PRESETS, formatTime } from "./timefmt";

export type SettingsTabId = "appearance" | "layout" | "images" | "time" | "shortcuts";

export interface CodeThemeOption {
  readonly id: string;
  readonly label: string;
}

export const DEFAULT_SIDEBAR_FONT_SIZE = 14;
export const DEFAULT_EDITOR_FONT_SIZE = 16;
export const DEFAULT_OUTLINE_FONT_SIZE = 14;
export const DEFAULT_EDITOR_MAX_WIDTH = 820;

const WIDTH_PRESETS: readonly { label: string; value: number }[] = [
  { label: "紧凑 680", value: 680 },
  { label: "标准 820", value: 820 },
  { label: "宽屏 960", value: 960 },
  { label: "超宽 1120", value: 1120 },
  { label: "铺满", value: 0 },
];

// 1x1 透明 PNG，用于「测试上传」校验图床接口联通性与响应路径提取。
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export interface NotesSettingsModalProps {
  initialTab?: SettingsTabId;
  notePath: string;
  codeTheme: string;
  codeThemes: readonly CodeThemeOption[];
  highlightColor: HighlightColorId;
  highlightHistory: readonly string[];
  sidebarFontSize: number;
  editorFontSize: number;
  outlineFontSize: number;
  editorMaxWidth: number;
  sidebarBounds: PanelBounds;
  outlineBounds: PanelBounds;
  imagePrefs: ImagePrefs;
  timeFormat: string;
  shortcuts: NoteShortcuts;
  onChangeCodeTheme: (id: string) => void;
  onChangeHighlightColor: (color: HighlightColorId, recordHistory?: boolean) => void;
  onChangeFontSizes: (patch: { sidebarFontSize?: number; editorFontSize?: number; outlineFontSize?: number }) => void;
  onChangeEditorMaxWidth: (width: number) => void;
  onChangeSidebarBounds: (next: PanelBounds) => void;
  onChangeOutlineBounds: (next: PanelBounds) => void;
  onChangeImagePrefs: (patch: Partial<ImagePrefs>) => void;
  onChangeTimeFormat: (fmt: string) => void;
  onChangeShortcuts: (next: NoteShortcuts) => void;
  onResetAll: () => void;
  onToast: (text: string, error?: boolean) => void;
  onClose: () => void;
}

const TABS: readonly { id: SettingsTabId; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "外观与排版", icon: Palette },
  { id: "layout", label: "布局与栏宽", icon: LayoutPanelLeft },
  { id: "images", label: "图片与附件", icon: ImageIcon },
  { id: "time", label: "时间格式", icon: Clock },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
];

function parsePositiveNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

/** 固定尺寸的笔记设置弹窗：左侧分类导航 + 右侧独立滚动内容区，切换分组不抖动。 */
export function NotesSettingsModal(props: NotesSettingsModalProps) {
  const [tab, setTab] = useState<SettingsTabId>(props.initialTab ?? "appearance");
  const [now, setNow] = useState(() => new Date());
  const [hexDraft, setHexDraft] = useState<string>(() => highlightSwatchHex(props.highlightColor));
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [testingUpload, setTestingUpload] = useState(false);

  useEffect(() => {
    setHexDraft(highlightSwatchHex(props.highlightColor));
  }, [props.highlightColor]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.readOnly && active.closest(".fx-settings-dialog")) {
        e.preventDefault();
        e.stopPropagation();
        active.blur();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [props.onClose]);

  const hiVars = resolveHighlightVars(props.highlightColor);
  const activeHex = hiVars.swatch;
  const isCustomHexActive = !HIGHLIGHT_COLORS.some((c) => c.id === props.highlightColor);
  const conflicts = findShortcutConflicts(props.shortcuts);
  const dirExample = resolveImageDir(props.imagePrefs.dir, props.notePath || "示例笔记.md");

  const applyCustomHex = (raw: string, recordHistory = true) => {
    const hex = normalizeHexColor(raw);
    if (!hex) return;
    props.onChangeHighlightColor(hex, recordHistory);
  };

  const updateBoundField = (which: "sidebar" | "outline", field: keyof PanelBounds, raw: string) => {
    const val = parsePositiveNumber(raw);
    if (val === null) return;
    const base = which === "sidebar" ? props.sidebarBounds : props.outlineBounds;
    const next: PanelBounds = { ...base, [field]: Math.round(val) };
    if (field === "minWidth" && next.minWidth > next.maxWidth) next.maxWidth = next.minWidth;
    if (field === "maxWidth" && next.maxWidth < next.minWidth) next.minWidth = next.maxWidth;
    if (next.defaultWidth < next.minWidth) next.defaultWidth = next.minWidth;
    if (next.defaultWidth > next.maxWidth) next.defaultWidth = next.maxWidth;
    if (which === "sidebar") props.onChangeSidebarBounds(next);
    else props.onChangeOutlineBounds(next);
  };

  const testUpload = async () => {
    if (testingUpload) return;
    setTestingUpload(true);
    try {
      const url = await uploadImageToHost(
        { base64: TINY_PNG_BASE64, mime: "image/png", originalName: "pocket-test.png" },
        "pocket-test.png",
        props.imagePrefs,
      );
      props.onToast(`测试上传成功：${url}`);
    } catch (e) {
      props.onToast((e as Error).message || "测试上传失败", true);
    } finally {
      setTestingUpload(false);
    }
  };

  return (
    <div
      class="fx-confirm-backdrop fx-settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="笔记设置"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        class="fx-confirm-dialog fx-settings-dialog"
        data-mark-color={props.highlightColor}
        style={{ "--note-mark-hi-light": hiVars.light, "--note-mark-hi-dark": hiVars.dark } as Record<string, string>}
      >
        <div class="fx-settings-head">
          <div class="fx-settings-title">笔记设置</div>
          <Btn small ghost icon title="关闭" onClick={props.onClose}>
            <X size={15} />
          </Btn>
        </div>

        <div class="fx-settings-body">
          <aside class="fx-settings-sidebar">
            <nav class="fx-settings-nav" role="tablist" aria-orientation="vertical">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  class={`fx-settings-tab${tab === id ? " is-active" : ""}`}
                  onClick={() => {
                    setConfirmResetAll(false);
                    setTab(id);
                  }}
                >
                  <Icon size={14} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <div class="fx-settings-nav-foot">
              {confirmResetAll ? (
                <div class="fx-settings-reset-confirm">
                  <span>恢复全部默认？</span>
                  <div class="fx-settings-reset-btns">
                    <Btn small onClick={() => setConfirmResetAll(false)}>
                      取消
                    </Btn>
                    <Btn
                      small
                      primary
                      onClick={() => {
                        setConfirmResetAll(false);
                        props.onResetAll();
                      }}
                    >
                      确定
                    </Btn>
                  </div>
                </div>
              ) : (
                <button type="button" class="fx-settings-reset-all" onClick={() => setConfirmResetAll(true)}>
                  <RotateCcw size={13} />
                  <span>恢复全部默认</span>
                </button>
              )}
            </div>
          </aside>

          <div class="fx-settings-panel" role="tabpanel">
            {tab === "appearance" && (
              <div class="fx-settings-sections">
                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">荧光笔高亮颜色</div>
                      <div class="fx-settings-sec-desc">固定常用色点 + 最近使用历史 + 自定义色盘 / 色值输入</div>
                    </div>
                    {props.highlightColor !== DEFAULT_HIGHLIGHT_COLOR && (
                      <Btn small onClick={() => props.onChangeHighlightColor(DEFAULT_HIGHLIGHT_COLOR, false)}>
                        恢复默认
                      </Btn>
                    )}
                  </div>
                  <div class="fx-mark-dots-row">
                    <div class="fx-mark-dots-group" role="group" aria-label="常用荧光笔颜色">
                      {HIGHLIGHT_COLORS.map((c) => {
                        const active = props.highlightColor === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            class={`fx-color-dot${active ? " is-active" : ""}`}
                            title={`${c.label} (${c.swatch})`}
                            aria-label={`${c.label} ${c.swatch}`}
                            aria-pressed={active}
                            style={{ "--dot-color": c.swatch } as Record<string, string>}
                            onClick={() => props.onChangeHighlightColor(c.id, false)}
                          >
                            {active && <Check size={11} />}
                          </button>
                        );
                      })}
                    </div>

                    <span class="fx-mark-dots-sep" aria-hidden="true" />

                    <div class="fx-mark-dots-group" role="group" aria-label="最近使用的自定义颜色">
                      {Array.from({ length: MAX_HIGHLIGHT_HISTORY }, (_, i) => {
                        const hex = props.highlightHistory[i];
                        if (!hex) {
                          return <span key={`slot-${i}`} class="fx-color-dot is-slot" title="最近使用的自定义颜色槽位" />;
                        }
                        const active = activeHex === hex.toLowerCase() && isCustomHexActive;
                        return (
                          <button
                            key={hex}
                            type="button"
                            class={`fx-color-dot${active ? " is-active" : ""}`}
                            title={`历史颜色 ${hex}`}
                            aria-label={`历史颜色 ${hex}`}
                            aria-pressed={active}
                            style={{ "--dot-color": hex } as Record<string, string>}
                            onClick={() => props.onChangeHighlightColor(hex as `#${string}`, true)}
                          >
                            {active && <Check size={11} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div class="fx-mark-custom-row">
                    <label class="fx-color-picker-btn" title="打开色盘自选颜色">
                      <Pipette size={13} />
                      <span>色盘</span>
                      <input
                        type="color"
                        aria-label="自定义荧光笔色盘"
                        value={activeHex}
                        onInput={(e) => {
                          const val = (e.target as HTMLInputElement).value;
                          setHexDraft(val);
                          applyCustomHex(val, false);
                        }}
                        onChange={(e) => {
                          const val = (e.target as HTMLInputElement).value;
                          setHexDraft(val);
                          applyCustomHex(val, true);
                        }}
                      />
                    </label>
                    <input
                      class="fx-hex-input"
                      aria-label="自定义荧光笔颜色代码"
                      placeholder="#fde047"
                      spellcheck={false}
                      value={hexDraft}
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        setHexDraft(val);
                        if (normalizeHexColor(val)) applyCustomHex(val, false);
                      }}
                      onBlur={() => {
                        const hex = normalizeHexColor(hexDraft);
                        if (hex) applyCustomHex(hex, true);
                        else setHexDraft(activeHex);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const hex = normalizeHexColor(hexDraft);
                          if (hex) applyCustomHex(hex, true);
                          else props.onToast("请输入有效的十六进制颜色，例如 #a7f3d0", true);
                        }
                      }}
                    />
                    <div class="fx-mark-preview is-inline">
                      <span>示例：</span>
                      <mark class="md-mark">荧光笔高亮效果</mark>
                    </div>
                  </div>
                </section>

                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">文字大小（px）</div>
                      <div class="fx-settings-sec-desc">可自由设定任意正数像素值；默认 文件栏 14 · 编辑区 16 · 大纲 14</div>
                    </div>
                    {(props.sidebarFontSize !== DEFAULT_SIDEBAR_FONT_SIZE ||
                      props.editorFontSize !== DEFAULT_EDITOR_FONT_SIZE ||
                      props.outlineFontSize !== DEFAULT_OUTLINE_FONT_SIZE) && (
                      <Btn
                        small
                        onClick={() =>
                          props.onChangeFontSizes({
                            sidebarFontSize: DEFAULT_SIDEBAR_FONT_SIZE,
                            editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
                            outlineFontSize: DEFAULT_OUTLINE_FONT_SIZE,
                          })
                        }
                      >
                        恢复默认
                      </Btn>
                    )}
                  </div>
                  <div class="fx-num-grid-3">
                    <label class="fx-settings-field">
                      <span>文件栏</span>
                      <input
                        type="number"
                        step="1"
                        aria-label="文件栏文字大小"
                        value={props.sidebarFontSize}
                        onInput={(e) => {
                          const v = parsePositiveNumber((e.target as HTMLInputElement).value);
                          if (v !== null) props.onChangeFontSizes({ sidebarFontSize: v });
                        }}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>编辑区</span>
                      <input
                        type="number"
                        step="1"
                        aria-label="编辑区文字大小"
                        value={props.editorFontSize}
                        onInput={(e) => {
                          const v = parsePositiveNumber((e.target as HTMLInputElement).value);
                          if (v !== null) props.onChangeFontSizes({ editorFontSize: v });
                        }}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>大纲</span>
                      <input
                        type="number"
                        step="1"
                        aria-label="大纲文字大小"
                        value={props.outlineFontSize}
                        onInput={(e) => {
                          const v = parsePositiveNumber((e.target as HTMLInputElement).value);
                          if (v !== null) props.onChangeFontSizes({ outlineFontSize: v });
                        }}
                      />
                    </label>
                  </div>
                </section>

                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">编辑区文字显示宽度</div>
                      <div class="fx-settings-sec-desc">居中限宽排布（设为 0 为铺满窗口），编辑区底部脚标也可随时滑动调节并自动记住</div>
                    </div>
                    {props.editorMaxWidth !== DEFAULT_EDITOR_MAX_WIDTH && (
                      <Btn small onClick={() => props.onChangeEditorMaxWidth(DEFAULT_EDITOR_MAX_WIDTH)}>
                        恢复默认
                      </Btn>
                    )}
                  </div>
                  <div class="fx-width-control-row">
                    <input
                      type="range"
                      min={480}
                      max={1600}
                      step={20}
                      aria-label="编辑区文字显示宽度滑块"
                      value={props.editorMaxWidth > 0 ? Math.max(480, Math.min(1600, props.editorMaxWidth)) : 1600}
                      onInput={(e) => props.onChangeEditorMaxWidth(Number((e.target as HTMLInputElement).value))}
                    />
                    <input
                      type="number"
                      class="fx-width-num-input"
                      aria-label="编辑区文字显示宽度像素"
                      value={props.editorMaxWidth}
                      onInput={(e) => {
                        const raw = (e.target as HTMLInputElement).value.trim();
                        if (raw === "0") {
                          props.onChangeEditorMaxWidth(0);
                          return;
                        }
                        const v = parsePositiveNumber(raw);
                        if (v !== null) props.onChangeEditorMaxWidth(Math.round(v));
                      }}
                    />
                    <span class="fx-unit-label">{props.editorMaxWidth > 0 ? "px" : "铺满"}</span>
                  </div>
                  <div class="pocket-time-presets">
                    {WIDTH_PRESETS.map((p) => (
                      <Btn key={p.label} small primary={props.editorMaxWidth === p.value} onClick={() => props.onChangeEditorMaxWidth(p.value)}>
                        {p.label}
                      </Btn>
                    ))}
                  </div>
                </section>

                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">代码块配色</div>
                      <div class="fx-settings-sec-desc">仅影响笔记内围栏代码块的语法高亮主题</div>
                    </div>
                    {props.codeTheme !== "auto" && (
                      <Btn small onClick={() => props.onChangeCodeTheme("auto")}>
                        恢复默认
                      </Btn>
                    )}
                  </div>
                  <div class="fx-theme-grid">
                    {props.codeThemes.map((t) => {
                      const active = props.codeTheme === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          class={`fx-theme-card${active ? " is-active" : ""}`}
                          aria-pressed={active}
                          onClick={() => props.onChangeCodeTheme(t.id)}
                        >
                          <span class={`fx-code-swatch is-${t.id}`} />
                          <span>{t.label}</span>
                          {active && <Check size={12} class="fx-menu-check" />}
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}

            {tab === "layout" && (
              <div class="fx-settings-sections">
                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">文件栏宽度（px）</div>
                      <div class="fx-settings-sec-desc">设置左侧文件栏的默认、最小与最大拖动宽度；双击分隔条将恢复到默认宽度</div>
                    </div>
                    {(props.sidebarBounds.defaultWidth !== DEFAULT_SIDEBAR_BOUNDS.defaultWidth ||
                      props.sidebarBounds.minWidth !== DEFAULT_SIDEBAR_BOUNDS.minWidth ||
                      props.sidebarBounds.maxWidth !== DEFAULT_SIDEBAR_BOUNDS.maxWidth) && (
                      <Btn small onClick={() => props.onChangeSidebarBounds({ ...DEFAULT_SIDEBAR_BOUNDS })}>
                        恢复默认
                      </Btn>
                    )}
                  </div>
                  <div class="fx-num-grid-3">
                    <label class="fx-settings-field">
                      <span>默认宽度</span>
                      <input
                        type="number"
                        aria-label="文件栏默认宽度"
                        value={props.sidebarBounds.defaultWidth}
                        onChange={(e) => updateBoundField("sidebar", "defaultWidth", (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>最小宽度</span>
                      <input
                        type="number"
                        aria-label="文件栏最小宽度"
                        value={props.sidebarBounds.minWidth}
                        onChange={(e) => updateBoundField("sidebar", "minWidth", (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>最大宽度</span>
                      <input
                        type="number"
                        aria-label="文件栏最大宽度"
                        value={props.sidebarBounds.maxWidth}
                        onChange={(e) => updateBoundField("sidebar", "maxWidth", (e.target as HTMLInputElement).value)}
                      />
                    </label>
                  </div>
                </section>

                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">大纲栏宽度（px）</div>
                      <div class="fx-settings-sec-desc">设置右侧大纲栏的默认、最小与最大拖动宽度；窗口较窄时仍自动保障编辑区可见</div>
                    </div>
                    {(props.outlineBounds.defaultWidth !== DEFAULT_OUTLINE_BOUNDS.defaultWidth ||
                      props.outlineBounds.minWidth !== DEFAULT_OUTLINE_BOUNDS.minWidth ||
                      props.outlineBounds.maxWidth !== DEFAULT_OUTLINE_BOUNDS.maxWidth) && (
                      <Btn small onClick={() => props.onChangeOutlineBounds({ ...DEFAULT_OUTLINE_BOUNDS })}>
                        恢复默认
                      </Btn>
                    )}
                  </div>
                  <div class="fx-num-grid-3">
                    <label class="fx-settings-field">
                      <span>默认宽度</span>
                      <input
                        type="number"
                        aria-label="大纲默认宽度"
                        value={props.outlineBounds.defaultWidth}
                        onChange={(e) => updateBoundField("outline", "defaultWidth", (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>最小宽度</span>
                      <input
                        type="number"
                        aria-label="大纲最小宽度"
                        value={props.outlineBounds.minWidth}
                        onChange={(e) => updateBoundField("outline", "minWidth", (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>最大宽度</span>
                      <input
                        type="number"
                        aria-label="大纲最大宽度"
                        value={props.outlineBounds.maxWidth}
                        onChange={(e) => updateBoundField("outline", "maxWidth", (e.target as HTMLInputElement).value)}
                      />
                    </label>
                  </div>
                </section>
              </div>
            )}

            {tab === "images" && (
              <div class="fx-settings-sections">
                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">图片粘贴与保存方式</div>
                      <div class="fx-settings-sec-desc">粘贴截图或拖入图片时自动持久化保存，不再丢失或写入超长 Base64</div>
                    </div>
                    <Btn small onClick={() => props.onChangeImagePrefs({ ...defaultImagePrefs })}>
                      恢复默认
                    </Btn>
                  </div>
                  <div class="fx-radio-row">
                    <button
                      type="button"
                      class={`fx-theme-card${props.imagePrefs.mode === "local" ? " is-active" : ""}`}
                      onClick={() => props.onChangeImagePrefs({ mode: "local" })}
                    >
                      <span>复制到指定目录（本地相对路径）</span>
                      {props.imagePrefs.mode === "local" && <Check size={12} class="fx-menu-check" />}
                    </button>
                    <button
                      type="button"
                      class={`fx-theme-card${props.imagePrefs.mode === "upload" ? " is-active" : ""}`}
                      onClick={() => props.onChangeImagePrefs({ mode: "upload" })}
                    >
                      <span>上传到自定义图床 URL</span>
                      {props.imagePrefs.mode === "upload" && <Check size={12} class="fx-menu-check" />}
                    </button>
                  </div>

                  <label class="fx-settings-field">
                    <span>本地图片保存目录（支持 ${"{filename}"} 代表当前笔记名）</span>
                    <input
                      aria-label="本地图片保存目录"
                      value={props.imagePrefs.dir}
                      placeholder="./img/"
                      spellcheck={false}
                      onInput={(e) => props.onChangeImagePrefs({ dir: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                  <div class="fx-settings-sec-desc">
                    写入示例：Markdown 链接 <code>{`${dirExample.mdPrefix}示例图.png`}</code> · 磁盘位置 <code>{dirExample.storeDir || "."}</code>
                  </div>

                  <div class="fx-settings-inline-row">
                    <label class="fx-settings-field fx-grow-1">
                      <span>默认命名规则</span>
                      <select
                        aria-label="图片默认命名规则"
                        value={props.imagePrefs.renameMode}
                        onChange={(e) => props.onChangeImagePrefs({ renameMode: (e.target as HTMLSelectElement).value as ImageRenameMode })}
                      >
                        <option value="timestamp">时间戳（20261119-203500.png）</option>
                        <option value="timestamp-rand">时间戳 + 随机码（防并发冲突）</option>
                        <option value="original">保留原文件名（重名自动加序号）</option>
                      </select>
                    </label>
                  </div>

                  <label class="fx-check-row">
                    <input
                      type="checkbox"
                      checked={props.imagePrefs.promptRename}
                      onChange={(e) => props.onChangeImagePrefs({ promptRename: (e.target as HTMLInputElement).checked })}
                    />
                    <div>
                      <div class="fx-check-title">插入图片时弹出手动重命名框</div>
                      <div class="fx-settings-sec-desc">开启后每次粘贴/拖入图片都会先预览并允许手动输入有意义的文件名，方便日后查阅图片目录</div>
                    </div>
                  </label>
                </section>

                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">通用图床接口配置</div>
                      <div class="fx-settings-sec-desc">兼容 PicGo / 兰空 / Chevereto / 自建 HTTP 上传接口</div>
                    </div>
                    <Btn small disabled={testingUpload || !props.imagePrefs.uploadUrl.trim()} onClick={() => void testUpload()}>
                      <Upload size={12} />
                      <span>{testingUpload ? "测试中…" : "测试上传"}</span>
                    </Btn>
                  </div>

                  <div class="fx-upload-grid">
                    <label class="fx-settings-field fx-span-2">
                      <span>上传接口 URL</span>
                      <input
                        aria-label="图床上传接口 URL"
                        value={props.imagePrefs.uploadUrl}
                        placeholder="https://example.com/api/upload 或 http://127.0.0.1:36677/upload"
                        spellcheck={false}
                        onInput={(e) => props.onChangeImagePrefs({ uploadUrl: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>请求方法</span>
                      <select
                        aria-label="图床请求方法"
                        value={props.imagePrefs.uploadMethod}
                        onChange={(e) => props.onChangeImagePrefs({ uploadMethod: (e.target as HTMLSelectElement).value as "POST" | "PUT" })}
                      >
                        <option value="POST">POST (multipart/form-data)</option>
                        <option value="PUT">PUT (原始二进制流)</option>
                      </select>
                    </label>
                    <label class="fx-settings-field">
                      <span>表单文件字段名</span>
                      <input
                        aria-label="图床文件字段名"
                        value={props.imagePrefs.uploadField}
                        placeholder="file"
                        spellcheck={false}
                        onInput={(e) => props.onChangeImagePrefs({ uploadField: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                    <label class="fx-settings-field fx-span-2">
                      <span>响应 JSON 图片链接提取路径（留空自动提取首个 URL）</span>
                      <input
                        aria-label="响应链接提取路径"
                        value={props.imagePrefs.uploadResponsePath}
                        placeholder="data.url 或 result[0]"
                        spellcheck={false}
                        onInput={(e) => props.onChangeImagePrefs({ uploadResponsePath: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>自定义 Headers（JSON）</span>
                      <input
                        aria-label="图床自定义请求头"
                        value={props.imagePrefs.uploadHeaders}
                        placeholder='{"Authorization":"Bearer ..."}'
                        spellcheck={false}
                        onInput={(e) => props.onChangeImagePrefs({ uploadHeaders: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                    <label class="fx-settings-field">
                      <span>附加表单字段（JSON）</span>
                      <input
                        aria-label="图床附加字段"
                        value={props.imagePrefs.uploadExtraFields}
                        placeholder='{"album":"notes"}'
                        spellcheck={false}
                        onInput={(e) => props.onChangeImagePrefs({ uploadExtraFields: (e.target as HTMLInputElement).value })}
                      />
                    </label>
                  </div>

                  <label class="fx-check-row">
                    <input
                      type="checkbox"
                      checked={props.imagePrefs.fallbackToLocal}
                      onChange={(e) => props.onChangeImagePrefs({ fallbackToLocal: (e.target as HTMLInputElement).checked })}
                    />
                    <div>
                      <div class="fx-check-title">上传失败时自动回退保存到本地目录</div>
                      <div class="fx-settings-sec-desc">断网或图床异常时仍将图片写入本地目录，确保图片绝不丢失</div>
                    </div>
                  </label>
                </section>
              </div>
            )}

            {tab === "time" && (
              <div class="fx-settings-sections">
                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">插入当前时间格式</div>
                      <div class="fx-settings-sec-desc">用于 `/` 斜线菜单与右键菜单「插入 → 当前时间」</div>
                    </div>
                    <Btn small onClick={() => props.onChangeTimeFormat(DEFAULT_TIME_FORMAT)}>
                      恢复默认
                    </Btn>
                  </div>
                  <div class="fx-time-live-box">{formatTime(now, props.timeFormat)}</div>
                  <label class="fx-settings-field">
                    <span>格式模板</span>
                    <input
                      value={props.timeFormat}
                      placeholder={DEFAULT_TIME_FORMAT}
                      aria-label="时间格式模板"
                      onInput={(e) => props.onChangeTimeFormat((e.target as HTMLInputElement).value)}
                    />
                  </label>
                  <div class="fx-settings-sec-desc">
                    可用占位符：<code>YYYY</code> 年、<code>MM</code>/<code>M</code> 月、<code>DD</code>/<code>D</code> 日、<code>HH</code>/<code>H</code> 时、<code>mm</code>/<code>m</code> 分、<code>ss</code>/<code>s</code> 秒、<code>ddd</code> 周几、<code>dddd</code> 星期几
                  </div>
                  <div class="pocket-time-presets">
                    {TIME_FORMAT_PRESETS.map((preset) => (
                      <Btn
                        key={preset}
                        small
                        primary={(props.timeFormat || DEFAULT_TIME_FORMAT) === preset}
                        onClick={() => props.onChangeTimeFormat(preset)}
                      >
                        {preset}
                      </Btn>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {tab === "shortcuts" && (
              <div class="fx-settings-sections">
                <section class="fx-settings-section">
                  <div class="fx-settings-sec-head">
                    <div>
                      <div class="fx-settings-sec-title">自定义编辑快捷键（类 Typora）</div>
                      <div class="fx-settings-sec-desc">点击按键框后直接按下组合键（需含 Ctrl / ⌘ / Alt）；按 Backspace 清空，Esc 取消</div>
                    </div>
                    <Btn small onClick={() => props.onChangeShortcuts({ ...defaultShortcuts })}>
                      恢复默认
                    </Btn>
                  </div>

                  {SHORTCUT_GROUPS.map((grp) => (
                    <div key={grp.id} class="fx-shortcut-group">
                      <div class="fx-shortcut-group-title">{grp.label}</div>
                      <div class="fx-shortcut-list">
                        {SHORTCUT_ITEMS.filter((it) => it.group === grp.id).map((item) => {
                          const val = props.shortcuts[item.id] ?? "";
                          const isDefault = val === defaultShortcuts[item.id];
                          const hasConflict = conflicts.has(item.id);
                          return (
                            <div key={item.id} class="fx-shortcut-item">
                              <span class="fx-shortcut-label">
                                {item.label}
                                {hasConflict && <em class="fx-shortcut-conflict">冲突</em>}
                              </span>
                              <div class="fx-shortcut-input-group">
                                <input
                                  readOnly
                                  class={`fx-shortcut-input${hasConflict ? " is-conflict" : ""}`}
                                  value={val}
                                  placeholder="未设置"
                                  aria-label={item.id === "above" ? "上方插行快捷键" : item.id === "below" ? "下方插行快捷键" : `${item.label}快捷键`}
                                  title="点击后按下新快捷键，Backspace 清空，Esc 取消"
                                  onKeyDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (e.key === "Escape") {
                                      (e.target as HTMLInputElement).blur();
                                      return;
                                    }
                                    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
                                      props.onChangeShortcuts({ ...props.shortcuts, [item.id]: "" });
                                      return;
                                    }
                                    if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
                                    const nextKey = shortcutOf(e);
                                    if (!nextKey) return;
                                    const next: NoteShortcuts = { ...props.shortcuts, [item.id]: nextKey };
                                    props.onChangeShortcuts(next);
                                    const dup = (Object.keys(defaultShortcuts) as ShortcutActionId[]).find((k) => k !== item.id && next[k] === nextKey);
                                    if (dup) {
                                      const dupLabel = SHORTCUT_ITEMS.find((x) => x.id === dup)?.label ?? dup;
                                      props.onToast(`快捷键 ${nextKey} 与「${dupLabel}」冲突`, true);
                                    }
                                  }}
                                />
                                {!isDefault && (
                                  <Btn
                                    small
                                    ghost
                                    icon
                                    title={`恢复默认 (${defaultShortcuts[item.id]})`}
                                    onClick={() => props.onChangeShortcuts({ ...props.shortcuts, [item.id]: defaultShortcuts[item.id] })}
                                  >
                                    <RotateCcw size={12} />
                                  </Btn>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
