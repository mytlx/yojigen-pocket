import { useEffect, useState } from "preact/hooks";
import { Finder, type FileDetail } from "../mygo";
import { Icon } from "./icons";
import { renderMarkdown } from "./markdown";
import "./filepreview.css";

interface Attr {
  label: string;
  value: string;
}

function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/**
 * 文件的预览区和属性区。搜索框的结果预览和高级搜索共用。
 *
 * 能直接看的（图片、视频、音频、PDF、文本、压缩包、文件夹）就直接看；看不了的向系统要一张预览图；
 * 还是没有的话，不留一块空白，而是把图标和属性铺满整个区域。
 */
export function FilePreview({ path, showPreview, showMeta, detail: given }: { path: string; showPreview: boolean; showMeta: boolean; detail?: FileDetail }) {
  const [detail, setDetail] = useState<FileDetail | null>(given ?? null);
  const [thumb, setThumb] = useState<"" | "loading" | string>("");
  const [failed, setFailed] = useState(false); // 媒体加载失败（这个内核解不了这种编码）
  const [media, setMedia] = useState<Attr[]>([]);

  useEffect(() => {
    let alive = true;
    setThumb("");
    setFailed(false);
    setMedia([]);
    if (given) {
      setDetail(given);
      return;
    }
    setDetail(null);
    void Finder.detail(path).then((d) => alive && setDetail(d));
    return () => {
      alive = false;
    };
  }, [path, given]);

  // 没法直接预览、或视频放不出来时，向系统要一张预览图。
  const needThumb = !!detail && showPreview && detail.canThumb && (detail.kind === "none" || failed);
  useEffect(() => {
    if (!needThumb || !detail) return;
    let alive = true;
    setThumb("loading");
    void Finder.thumbnail(detail.path).then((url) => alive && setThumb(url || ""));
    return () => {
      alive = false;
    };
  }, [needThumb, detail?.path]);

  if (!detail) return <div class="fp" />;
  const attrs: Attr[] = [...(detail.attrs ?? [])];
  // 时长、分辨率这些要等播放器读出来，插在“位置”后面。
  if (media.length) attrs.splice(Math.min(4, attrs.length), 0, ...media);

  let body: preact.ComponentChildren = null;
  if (showPreview && !detail.error) {
    const kind = failed ? "none" : detail.kind;
    switch (kind) {
      case "image":
        body = (
          <div class="fp-media">
            <img
              src={detail.url}
              alt=""
              draggable={false}
              onError={() => setFailed(true)}
              onLoad={(e) => {
                const el = e.target as HTMLImageElement;
                if (!attrs.some((a) => a.label === "尺寸") && el.naturalWidth) setMedia([{ label: "尺寸", value: `${el.naturalWidth} × ${el.naturalHeight} 像素` }]);
              }}
            />
          </div>
        );
        break;
      case "video":
        body = (
          <div class="fp-media">
            <video
              src={detail.url}
              controls
              preload="metadata"
              onError={() => setFailed(true)}
              onLoadedMetadata={(e) => {
                const el = e.target as HTMLVideoElement;
                const out: Attr[] = [];
                if (el.videoWidth) out.push({ label: "分辨率", value: `${el.videoWidth} × ${el.videoHeight}` });
                if (duration(el.duration)) out.push({ label: "时长", value: duration(el.duration) });
                setMedia(out);
              }}
            />
          </div>
        );
        break;
      case "audio":
        body = (
          <div class="fp-media is-audio">
            <Icon icon={detail.icon} size={72} />
            <audio
              src={detail.url}
              controls
              preload="metadata"
              onError={() => setFailed(true)}
              onLoadedMetadata={(e) => {
                const d = duration((e.target as HTMLAudioElement).duration);
                if (d) setMedia([{ label: "时长", value: d }]);
              }}
            />
          </div>
        );
        break;
      case "pdf":
        body = <iframe class="fp-frame" src={`${detail.url}#toolbar=0&navpanes=0&view=FitH`} title={detail.name} />;
        break;
      case "markdown":
        body = <div class="fp-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.text ?? "") }} />;
        break;
      case "text":
      case "code":
        body = <pre class={`fp-text${kind === "code" ? " is-code" : ""}`}>{detail.text}</pre>;
        break;
      case "archive":
      case "folder":
        body = (
          <div class="fp-entries">
            {(detail.entries ?? []).map((e, i) => (
              <div key={i} class={e.endsWith("/") ? "is-dir" : ""}>
                {e}
              </div>
            ))}
            {(detail.total ?? 0) > (detail.entries?.length ?? 0) && <div class="fp-more">还有 {(detail.total ?? 0) - (detail.entries?.length ?? 0)} 项没有列出</div>}
            {(detail.entries?.length ?? 0) === 0 && <div class="fp-more">空的</div>}
          </div>
        );
        break;
      default:
        if (thumb && thumb !== "loading") {
          body = (
            <div class="fp-media">
              <img src={thumb} alt="" draggable={false} />
            </div>
          );
        }
    }
  }

  const truncated = showPreview && detail.truncated && (detail.kind === "text" || detail.kind === "code" || detail.kind === "markdown");
  // 没有可看的内容：图标和名字做个抬头，属性铺满，不留空白。
  const bare = !body;
  return (
    <div class={`fp${bare ? " is-bare" : ""}`}>
      {body && <div class="fp-body">{body}</div>}
      {truncated && <div class="fp-note">内容较长，只显示了开头</div>}
      {bare && (showPreview || !showMeta) && (
        <div class="fp-card">
          <Icon icon={detail.icon} size={56} />
          <div class="fp-card-text">
            <b>{detail.name}</b>
            <span>
              {detail.error
                ? detail.error
                : showPreview
                  ? thumb === "loading"
                    ? "正在生成预览…"
                    : failed
                      ? `${detail.typeName} · 这种编码在这里播放不了`
                      : `${detail.typeName} · 这种文件没法直接预览`
                  : detail.typeName}
            </span>
          </div>
        </div>
      )}
      {(showMeta || bare) && attrs.length > 0 && (
        <dl class="fp-attrs">
          {attrs.map((a) => (
            <div key={a.label}>
              <dt>{a.label}</dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
