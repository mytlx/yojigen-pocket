import { pocket, type FileNode, type Language, type PocketContext, type RunEvent } from "../../sdk/pocket";

/** 这个扩展里的页面和宿主打交道的地方。页面只用这里的东西，不直接碰 window.pocket。 */

export type Node = FileNode;
export type ScratchLang = Language;
export type { RunEvent };

export interface Ctx {
  platform: string;
  detached: boolean;
  toast(text: string, error?: boolean): void;
  copy(text: string, label?: string): Promise<void>;
  remember(value: string): void;
}

export interface FeatureProps {
  input: string;
  args: Record<string, string>;
  ctx: Ctx;
}

export const makeCtx = (c: PocketContext): Ctx => ({
  platform: c.platform,
  detached: c.detached,
  toast: (text, error) => void pocket.ui.toast(text, error),
  copy: (text, label) => pocket.ui.copy(text, label),
  remember: (value) => void pocket.ui.remember(value),
});

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 只留文件夹和 .md 文件。 */
function onlyMarkdown(nodes: Node[]): Node[] {
  return nodes
    .filter((n) => n.isDir || n.name.toLowerCase().endsWith(".md"))
    .map((n) => (n.isDir ? { ...n, children: onlyMarkdown(n.children ?? []) } : n));
}

/** 别的页面（同一个扩展的另一个窗口）改了文件。 */
export interface FsChange {
  root: string;
  op: "write" | "create" | "rename" | "delete";
  path: string;
  /** 改名或移动之后的新路径。 */
  to?: string;
}

/** 用系统浏览器（或对应的应用）打开一个地址。 */
export const openExternal = (url: string) => pocket.openExternal(url);

const NOTES = "notes";

/** 笔记：用户目录 notes 里的 .md 文件。 */
export const Notes = {
  tree: () => pocket.fs.tree(NOTES).then(onlyMarkdown),
  read: (path: string) => pocket.fs.read(NOTES, path),
  write: (path: string, content: string) => pocket.fs.write(NOTES, path, content),
  /** 新笔记的名字带当天的日期，重名时宿主会自动加序号。 */
  newNote: (dir: string) => pocket.fs.createFile(NOTES, dir, `${today()} 笔记.md`, ""),
  createNote: (dir: string, name: string, content = "") => pocket.fs.createFile(NOTES, dir, /\.md$/i.test(name) ? name : `${name}.md`, content),
  newFolder: (dir: string) => pocket.fs.createFolder(NOTES, dir, "新建文件夹"),
  /** 改名。笔记的名字不用带 .md，这里补上。 */
  rename: (path: string, name: string) => pocket.fs.rename(NOTES, path, /\.md$/i.test(path) && !/\.md$/i.test(name) ? `${name}.md` : name),
  move: (path: string, dir: string) => pocket.fs.move(NOTES, path, dir),
  delete: (path: string) => pocket.fs.delete(NOTES, path),
  reveal: (path: string) => pocket.fs.reveal(NOTES, path),
  open: (path: string) => pocket.fs.open(NOTES, path),
  openWith: (path: string) => pocket.fs.openWith(NOTES, path),
  saveAs: (name: string, content: string) => pocket.fs.saveAs(name, content),
  getMode: () => pocket.storage.get<string>("notes.mode").catch(() => null),
  setMode: (mode: string) => void pocket.storage.set("notes.mode", mode).catch(() => undefined),
  getPrefs: <T>() => pocket.storage.get<T>("notes.prefs").catch(() => null),
  setPrefs: (prefs: unknown) => void pocket.storage.set("notes.prefs", prefs).catch(() => undefined),
  getLast: () => pocket.storage.get<string>("notes.last").catch(() => null),
  setLast: (path: string) => void pocket.storage.set("notes.last", path).catch(() => undefined),
  getImported: () => pocket.storage.get<{ sig: string; path: string }>("notes.imported").catch(() => null),
  setImported: (v: { sig: string; path: string }) => void pocket.storage.set("notes.imported", v).catch(() => undefined),
  /** 笔记目录里的文件有变化（包括自己这个页面引起的）。 */
  onChange: (fn: (change: FsChange) => void) => pocket.on("fs", ((change: FsChange) => void (change.root === NOTES && fn(change))) as (data: never) => void),
};

const SCRATCHES = "scratches";

/** 代码草稿：用户目录 scratches 里的文件，运行和格式化交给宿主。 */
export const Scratch = {
  languages: () => pocket.runner.languages(),
  list: () => pocket.fs.tree(SCRATCHES),
  read: (path: string) => pocket.fs.read(SCRATCHES, path),
  write: (path: string, content: string) => pocket.fs.write(SCRATCHES, path, content),
  new: (ext: string) => pocket.fs.createFile(SCRATCHES, "", `scratch${ext}`, ""),
  /** 改名；没写扩展名时沿用原来的。 */
  rename: (path: string, name: string) => {
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
    return pocket.fs.rename(SCRATCHES, path, name.includes(".") ? name : name + ext);
  },
  delete: (path: string) => pocket.fs.delete(SCRATCHES, path),
  reveal: () => pocket.fs.reveal(SCRATCHES, ""),
  run: (request: { lang: string; code: string; stdin?: string; timeout?: number }, onEvent: (e: RunEvent) => void) => pocket.runner.run(request, onEvent),
  stop: () => pocket.runner.stop(),
  format: (lang: string, code: string) => pocket.runner.format(lang, code),
  getLast: () => pocket.storage.get<string>("scratch.last").catch(() => null),
  setLast: (path: string) => void pocket.storage.set("scratch.last", path).catch(() => undefined),
};
