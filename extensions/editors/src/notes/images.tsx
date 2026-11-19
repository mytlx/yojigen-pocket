import { useEffect, useRef, useState } from "preact/hooks";
import { Image as ImageIcon, X } from "lucide-preact";
import { Btn } from "../../../../src/features/ui";
import { Notes } from "../host";

export type ImageSaveMode = "local" | "upload";
export type ImageRenameMode = "timestamp" | "timestamp-rand" | "original";

export interface ImagePrefs {
  mode: ImageSaveMode;
  /** 本地保存目录模板（相对当前笔记目录），支持 ${filename}，默认 ./img/ */
  dir: string;
  renameMode: ImageRenameMode;
  /** 插入/粘贴图片时是否弹出手动重命名确认框 */
  promptRename: boolean;
  /** 通用图床 HTTP 接口地址（如 PicGo / Lsky / 自定义接口） */
  uploadUrl: string;
  uploadMethod: "POST" | "PUT";
  /** multipart 表单文件字段名，默认 file */
  uploadField: string;
  /** 自定义请求头 JSON，例如 {"Authorization":"Bearer xxx"} */
  uploadHeaders: string;
  /** 附加表单字段 JSON，例如 {"strategy_id":"1"} */
  uploadExtraFields: string;
  /** 从返回 JSON 中提取图片 URL 的路径，例如 data.url 或 result[0]；留空自动查找首个 http(s) 链接 */
  uploadResponsePath: string;
  /** 图床上传失败时自动回退保存到本地目录，防止丢图 */
  fallbackToLocal: boolean;
}

export const defaultImagePrefs: ImagePrefs = {
  mode: "local",
  dir: "./img/",
  renameMode: "timestamp",
  promptRename: false,
  uploadUrl: "",
  uploadMethod: "POST",
  uploadField: "file",
  uploadHeaders: "",
  uploadExtraFields: "",
  uploadResponsePath: "data.url",
  fallbackToLocal: true,
};

export function normalizeImagePrefs(raw: Partial<ImagePrefs> | undefined | null): ImagePrefs {
  if (!raw || typeof raw !== "object") return { ...defaultImagePrefs };
  return {
    mode: raw.mode === "upload" ? "upload" : "local",
    dir: typeof raw.dir === "string" && raw.dir.trim() ? raw.dir.trim() : defaultImagePrefs.dir,
    renameMode: raw.renameMode === "timestamp-rand" || raw.renameMode === "original" ? raw.renameMode : "timestamp",
    promptRename: !!raw.promptRename,
    uploadUrl: typeof raw.uploadUrl === "string" ? raw.uploadUrl.trim() : "",
    uploadMethod: raw.uploadMethod === "PUT" ? "PUT" : "POST",
    uploadField: typeof raw.uploadField === "string" && raw.uploadField.trim() ? raw.uploadField.trim() : "file",
    uploadHeaders: typeof raw.uploadHeaders === "string" ? raw.uploadHeaders : "",
    uploadExtraFields: typeof raw.uploadExtraFields === "string" ? raw.uploadExtraFields : "",
    uploadResponsePath: typeof raw.uploadResponsePath === "string" ? raw.uploadResponsePath.trim() : defaultImagePrefs.uploadResponsePath,
    fallbackToLocal: raw.fallbackToLocal !== false,
  };
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
};

const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico"]);

export function extFromImage(name: string, mime?: string): string {
  const m = /(\.[a-z0-9]+)$/i.exec(name.trim());
  if (m && ALLOWED_IMAGE_EXTS.has(m[1]!.toLowerCase())) return m[1]!.toLowerCase();
  if (mime && MIME_TO_EXT[mime.toLowerCase()]) return MIME_TO_EXT[mime.toLowerCase()]!;
  return ".png";
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatStamp(d: Date) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function sanitizeImageName(raw: string, fallbackExt = ".png"): string {
  const ext = extFromImage(raw, undefined);
  const hasValidExt = /(\.[a-z0-9]+)$/i.test(raw.trim()) && ALLOWED_IMAGE_EXTS.has(ext);
  const stemRaw = hasValidExt ? raw.trim().slice(0, raw.trim().length - ext.length) : raw.trim();
  const safeStem = stemRaw
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  const finalStem = safeStem || `image-${formatStamp(new Date())}`;
  const finalExt = hasValidExt ? ext : ALLOWED_IMAGE_EXTS.has(fallbackExt.toLowerCase()) ? fallbackExt.toLowerCase() : ".png";
  return `${finalStem.slice(0, 120)}${finalExt}`;
}

export function buildImageFilename(originalName: string, mime: string, renameMode: ImageRenameMode, now = new Date()): string {
  const ext = extFromImage(originalName, mime);
  if (renameMode === "original" && originalName.trim() && !/^image\.(png|jpe?g|webp)$/i.test(originalName.trim())) {
    return sanitizeImageName(originalName, ext);
  }
  const stamp = formatStamp(now);
  if (renameMode === "timestamp-rand") {
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-${rand}${ext}`;
  }
  return `${stamp}${ext}`;
}

function normalizePosixSegments(parts: string[]): string[] {
  const out: string[] = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
    } else {
      out.push(seg);
    }
  }
  return out;
}

/**
 * 解析图片保存目录模板（例如 ./img/ 或 ./${filename}.assets/ 或 /images）：
 * - storeDir：相对 notes 根目录的路径（交给宿主 fs.writeBinary）
 * - mdPrefix：写入 Markdown 链接时的相对路径前缀（如 ./img/）
 */
export function resolveImageDir(template: string, notePath: string): { storeDir: string; mdPrefix: string } {
  const cleanNote = notePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const noteDir = cleanNote.includes("/") ? cleanNote.slice(0, cleanNote.lastIndexOf("/")) : "";
  const noteBase = cleanNote.includes("/") ? cleanNote.slice(cleanNote.lastIndexOf("/") + 1) : cleanNote;
  const noteStem = noteBase.replace(/\.md$/i, "") || "note";

  const raw = (template || "./img/").trim().replace(/\\/g, "/").replace(/\$\{filename\}/gi, noteStem);
  const isFromRoot = raw.startsWith("/");
  const baseParts = isFromRoot ? [] : noteDir ? noteDir.split("/") : [];
  const dirParts = normalizePosixSegments([...baseParts, ...raw.split("/")]);
  const storeDir = dirParts.join("/");

  // 计算从当前笔记目录到 storeDir 的标准相对路径（用于写回 Markdown）
  const fromParts = noteDir ? normalizePosixSegments(noteDir.split("/")) : [];
  let common = 0;
  while (common < fromParts.length && common < dirParts.length && fromParts[common] === dirParts[common]) {
    common++;
  }
  const ups = Array.from({ length: fromParts.length - common }, () => "..");
  const downs = dirParts.slice(common);
  const relJoined = [...ups, ...downs].join("/");
  const mdPrefix = !relJoined ? "./" : relJoined.startsWith("..") ? `${relJoined}/` : `./${relJoined}/`;
  return { storeDir, mdPrefix };
}

/** 把 Markdown 里的相对图片路径（./img/a.png、../img/a.png、img/a.png）解析为 notes 根目录下的相对路径。 */
export function resolveNoteRelativePath(notePath: string, rawSrc: string): string | null {
  const trimmed = rawSrc.trim();
  if (!trimmed) return null;
  if (/^(?:https?:|data:|blob:|pocketicon:|pocketplugin:|file:|mailto:|#)/i.test(trimmed)) return null;
  const noQuery = trimmed.split(/[?#]/)[0] ?? "";
  let decoded = noQuery;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch {
    /* 保留原样 */
  }
  const cleanNote = notePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const noteDir = cleanNote.includes("/") ? cleanNote.slice(0, cleanNote.lastIndexOf("/")) : "";
  const isFromRoot = decoded.startsWith("/");
  const baseParts = isFromRoot ? [] : noteDir ? noteDir.split("/") : [];
  const merged = [...baseParts, ...decoded.replace(/\\/g, "/").split("/")];
  // 禁止逃出 notes 根目录
  let depth = 0;
  for (const seg of merged) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      depth--;
      if (depth < 0) return null;
    } else {
      depth++;
    }
  }
  const normalized = normalizePosixSegments(merged).join("/");
  return normalized || null;
}

/** 按点/下标路径从 JSON 响应中提取图片 URL（如 data.url、result[0]），路径为空时自动搜索首个 http(s) URL。 */
export function extractUrlByPath(payload: unknown, pathExpr: string): string | null {
  const expr = pathExpr.trim();
  if (expr) {
    const tokens = expr
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .map((s) => s.trim())
      .filter(Boolean);
    let cur: unknown = payload;
    for (const tok of tokens) {
      if (cur == null || typeof cur !== "object") {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[tok];
    }
    if (typeof cur === "string" && /^https?:\/\//i.test(cur.trim())) {
      return cur.trim();
    }
  }
  // 回退：深度优先寻找第一个 http(s) 链接
  const seen = new Set<unknown>();
  const scan = (node: unknown): string | null => {
    if (typeof node === "string") {
      const t = node.trim();
      return /^https?:\/\/\S+$/i.test(t) ? t : null;
    }
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = scan(item);
        if (hit) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    for (const key of ["url", "link", "src", "href", "data", "result", "image"]) {
      if (key in obj) {
        const hit = scan(obj[key]);
        if (hit) return hit;
      }
    }
    for (const val of Object.values(obj)) {
      const hit = scan(val);
      if (hit) return hit;
    }
    return null;
  };
  return scan(payload);
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? "");
      const idx = res.indexOf(",");
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

function parseJsonRecord(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = String(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface PendingImageInput {
  base64: string;
  mime: string;
  originalName: string;
}

export interface StoredImageResult {
  /** 写入 Markdown 的链接地址（相对路径或图床 URL） */
  markdownUrl: string;
  /** 用于 alt 的简洁描述 */
  alt: string;
  /** 若保存在本地，返回 notes 根目录下的路径 */
  localRelPath?: string;
  /** 若由图床回退到本地，带上提示 */
  fallbackNotice?: string;
}

async function saveImageLocally(input: PendingImageInput, finalName: string, notePath: string, prefs: ImagePrefs): Promise<StoredImageResult> {
  const { storeDir, mdPrefix } = resolveImageDir(prefs.dir, notePath);
  const written = await Notes.writeImage(storeDir, finalName, input.base64);
  const actualName = written.includes("/") ? written.slice(written.lastIndexOf("/") + 1) : written;
  const encodedName = encodeURIComponent(actualName).replace(/%20/g, "%20");
  const encodedPrefix = mdPrefix
    .split("/")
    .map((seg) => (seg === "." || seg === ".." || seg === "" ? seg : encodeURIComponent(seg)))
    .join("/");
  return {
    markdownUrl: `${encodedPrefix}${encodedName}`,
    alt: actualName.replace(/\.[^.]+$/, ""),
    localRelPath: written,
  };
}

export async function uploadImageToHost(input: PendingImageInput, finalName: string, prefs: ImagePrefs): Promise<string> {
  const target = prefs.uploadUrl.trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("请先在设置中填写有效的图床上传 URL（http / https）");
  }
  const headers = parseJsonRecord(prefs.uploadHeaders);
  const fields = parseJsonRecord(prefs.uploadExtraFields);
  const res = await Notes.uploadImage(
    target,
    prefs.uploadMethod === "PUT"
      ? { method: "PUT", headers: { "Content-Type": input.mime || "image/png", ...headers }, bodyBase64: input.base64 }
      : {
          method: "POST",
          headers,
          multipart: {
            field: prefs.uploadField || "file",
            filename: finalName,
            mime: input.mime || "image/png",
            base64: input.base64,
            fields,
          },
        },
  );
  if (!res.ok) {
    throw new Error(`图床上传失败（HTTP ${res.status}）${res.text ? `：${res.text.slice(0, 120)}` : ""}`);
  }
  const rawText = (res.text ?? "").trim();
  if (/^https?:\/\/\S+$/i.test(rawText)) return rawText;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const m = /https?:\/\/[^\s"'<>]+/i.exec(rawText);
    if (m) return m[0];
    throw new Error("图床返回内容不是有效的 URL 或 JSON");
  }
  const extracted = extractUrlByPath(parsed, prefs.uploadResponsePath);
  if (!extracted) {
    throw new Error(`未在响应中找到图片 URL（当前提取路径：${prefs.uploadResponsePath || "自动"}）`);
  }
  return extracted;
}

export async function persistImage(
  input: PendingImageInput,
  finalName: string,
  notePath: string,
  prefs: ImagePrefs,
): Promise<StoredImageResult> {
  const safeName = sanitizeImageName(finalName, extFromImage(input.originalName, input.mime));
  if (prefs.mode === "upload" && prefs.uploadUrl.trim()) {
    try {
      const url = await uploadImageToHost(input, safeName, prefs);
      return { markdownUrl: url, alt: safeName.replace(/\.[^.]+$/, "") };
    } catch (err) {
      if (!prefs.fallbackToLocal) throw err;
      const local = await saveImageLocally(input, safeName, notePath, prefs);
      return { ...local, fallbackNotice: `${(err as Error).message}，已自动保存到本地目录` };
    }
  }
  return saveImageLocally(input, safeName, notePath, prefs);
}

export interface ImageRenameModalProps {
  previewDataUrl: string;
  initialName: string;
  targetHint: string;
  onConfirm: (filename: string) => void;
  onCancel: () => void;
}

/** 开启「插入图片时手动重命名」后的轻量确认弹窗，带缩略图预览与主名自动全选。 */
export function ImageRenameModal(props: ImageRenameModalProps) {
  const [name, setName] = useState(props.initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = props.initialName.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : props.initialName.length);
  }, [props.initialName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [props.onCancel]);

  const submit = () => {
    const trimmed = name.trim();
    props.onConfirm(trimmed || props.initialName);
  };

  return (
    <div
      class="fx-confirm-backdrop fx-img-rename-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="命名图片"
      onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}
    >
      <div class="fx-confirm-dialog fx-img-rename-dialog">
        <div class="fx-settings-head">
          <div class="fx-settings-title">
            <ImageIcon size={15} />
            <span>保存并命名图片</span>
          </div>
          <Btn small ghost icon title="取消" onClick={props.onCancel}>
            <X size={15} />
          </Btn>
        </div>
        <div class="fx-img-rename-body">
          <div class="fx-img-rename-preview">
            <img src={props.previewDataUrl} alt="待插入图片预览" />
          </div>
          <label class="fx-settings-field">
            <span>图片文件名</span>
            <input
              ref={inputRef}
              value={name}
              aria-label="图片文件名"
              spellcheck={false}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <div class="fx-settings-sec-desc">保存位置：{props.targetHint}</div>
        </div>
        <div class="fx-confirm-actions">
          <Btn onClick={props.onCancel}>取消</Btn>
          <Btn primary onClick={submit}>
            确认插入
          </Btn>
        </div>
      </div>
    </div>
  );
}
