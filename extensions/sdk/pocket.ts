/**
 * 扩展用的宿主接口（window.pocket）的类型。页面里先引入宿主提供的脚本：
 *
 *   <script src="/__pocket.js"></script>
 *
 * 然后 `import { pocket } from "../../sdk/pocket"` 就有类型提示了。接口都是异步的。
 */

export interface PocketContext {
  api: number;
  plugin: string;
  tool: string;
  /** 打开时带进来的文字（搜索框里关键词后面的内容、选中的文字）。 */
  input: string;
  /** 额外的参数。带入图片时有 image（文件路径），带入文件时有 files（JSON 数组）。 */
  args: Record<string, string>;
  detached: boolean;
  float: boolean;
  platform: "darwin" | "windows" | "linux";
  version: string;
}

export interface FileNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
  children?: FileNode[];
}

export interface RunEvent {
  kind: "start" | "stdout" | "stderr" | "exit";
  text?: string;
  code: number;
  millis?: number;
  stopped?: boolean;
  note?: string;
}

export interface Language {
  id: string;
  name: string;
  ext: string;
  tool?: string;
  formatter?: string;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text?: string;
  base64?: string;
}

export interface Pocket {
  api: number;
  context: PocketContext | null;
  /** 宿主把上下文交过来之后完成。 */
  ready: Promise<PocketContext>;
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, fn: (data: never) => void): () => void;
  /** 每次带着内容进来时调用（第一次打开，以及窗口开着时再次被叫到）。 */
  onEnter(fn: (ctx: PocketContext) => void): () => void;
  ui: {
    toast(text: string, error?: boolean): Promise<void>;
    copy(text: string, label?: string): Promise<void>;
    close(): Promise<void>;
    detach(): Promise<void>;
    /** 记下当前的主要内容：分离成独立窗口时带过去。 */
    remember(value: string): Promise<void>;
  };
  storage: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };
  /** 文件读写。root 为空是扩展自己的私有目录；其余的要在清单的 permissions.dirs 里声明。 */
  fs: {
    tree(root?: string): Promise<FileNode[]>;
    read(root: string, path: string): Promise<string>;
    write(root: string, path: string, content: string): Promise<void>;
    createFile(root: string, dir: string, name: string, content?: string): Promise<string>;
    createFolder(root: string, dir: string, name: string): Promise<string>;
    rename(root: string, path: string, name: string): Promise<string>;
    move(root: string, path: string, dir: string): Promise<string>;
    delete(root: string, path: string): Promise<void>;
    reveal(root: string, path?: string): Promise<void>;
    open(root: string, path: string): Promise<void>;
    openWith(root: string, path: string): Promise<void>;
    pick(exts?: string[]): Promise<{ name: string; path: string; text?: string; base64?: string } | null>;
    saveAs(name: string, content: string): Promise<string>;
  };
  fetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResult>;
  runner: {
    languages(): Promise<Language[]>;
    format(lang: string, code: string): Promise<string>;
    run(request: { lang: string; code: string; stdin?: string; timeout?: number }, onEvent: (e: RunEvent) => void): Promise<void>;
    stop(): Promise<void>;
  };
  /** 悬浮窗工具专用。 */
  window: {
    info(): Promise<{ x: number; y: number; width: number; height: number; area: { x: number; y: number; width: number; height: number } }>;
    move(dx: number, dy: number): Promise<{ x: number; y: number; hit: boolean }>;
    ground(): Promise<number>;
    resize(width: number, height: number): Promise<void>;
    dragStart(): Promise<void>;
    dragMove(dx: number, dy: number): Promise<void>;
    setAlwaysOnTop(on: boolean): Promise<void>;
    close(): Promise<void>;
  };
  backend: { call<T = unknown>(method: string, ...params: unknown[]): Promise<T>; on(fn: (msg: { event: string; data: unknown }) => void): () => void };
  copyText(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body?: string): Promise<void>;
  hide(): Promise<void>;
}

export const pocket = (window as unknown as { pocket: Pocket }).pocket;
