import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { FeatureProps } from "./types";

/**
 * 按需加载的功能页。带着大依赖的页面（代码编辑器、Markdown 编辑器）用它包一层，
 * 打开那一页时才下载对应的代码，主窗口启动不受影响。
 */
export function lazyFeature(load: () => Promise<FunctionComponent<FeatureProps>>): FunctionComponent<FeatureProps> {
  let cached: FunctionComponent<FeatureProps> | null = null;
  return function Lazy(props: FeatureProps) {
    const [Comp, setComp] = useState<FunctionComponent<FeatureProps> | null>(() => cached);
    const [failed, setFailed] = useState("");
    useEffect(() => {
      if (cached) return;
      let alive = true;
      load().then(
        (c) => {
          cached = c;
          if (alive) setComp(() => c);
        },
        (e: Error) => alive && setFailed(e.message || "加载失败"),
      );
      return () => {
        alive = false;
      };
    }, []);
    if (failed) return <div class="pk-empty">这个页面加载失败：{failed}</div>;
    if (!Comp) {
      return (
        <div class="fx-page fx-loading">
          <span class="ui-spinner" />
        </div>
      );
    }
    return <Comp {...props} />;
  };
}
