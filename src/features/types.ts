/** 功能页的运行环境：主窗口里，或者分离出来的独立窗口。 */
export interface FeatureCtx {
  detached: boolean;
  stealth: boolean;
  platform: string;
  /** 显示一条提示。 */
  toast(text: string, error?: boolean): void;
  /** 复制并提示。 */
  copy(text: string, label?: string): Promise<void>;
  /** 切到另一个功能页（例如识别后去翻译）。 */
  open(feature: string, input?: string, args?: Record<string, string>): void;
  /** 关闭这个功能页：主窗口里是返回搜索，独立窗口里是关窗口。 */
  close(): void;
  /** 分离成独立窗口（已经是独立窗口时什么都不做）。 */
  detach(): void;
  openSettings(section: string): void;
  /** 分离窗口的快捷键（accelerator 写法）；扩展页面里按下时由宿主处理。 */
  detachKey?: string;
  /** 记下功能页当前的主要内容：分离成独立窗口时带过去。 */
  remember(value: string): void;
}

export interface FeatureProps {
  input: string;
  args: Record<string, string>;
  ctx: FeatureCtx;
}
