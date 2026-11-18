import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { pocket, type PocketContext } from "../../sdk/pocket";
import "../../../src/shared/tokens.css";
import "../../../src/shared/motion.css";
import "../../../src/shared/controls.css";
import "../../../src/features/features.css";
import "./editors.css";
import { lazyFeature } from "./lazy";
import { makeCtx } from "./host";
import { installTooltips } from "../../../src/shared/tooltip";
import { installZoom } from "../../../src/shared/zoom";

installTooltips();
installZoom();

// 三个工具共用一个入口：打开哪个由宿主告诉我们，用到哪个才加载哪个的代码。
const tools = {
  notes: lazyFeature(() => import("./notes").then((m) => m.NotesTool)),
  scratch: lazyFeature(() => import("./scratch").then((m) => m.ScratchTool)),
  diff: lazyFeature(() => import("./diff").then((m) => m.DiffTool)),
};

function App() {
  const [ctx, setCtx] = useState<PocketContext | null>(null);
  useEffect(() => pocket.onEnter((c) => setCtx({ ...c })), []);
  if (!ctx) return null;
  const Tool = tools[ctx.tool as keyof typeof tools];
  if (!Tool) return <div class="pk-empty">没有这个工具：{ctx.tool}</div>;
  return <Tool input={ctx.input} args={ctx.args} ctx={makeCtx(ctx)} />;
}

render(<App />, document.getElementById("app")!);
