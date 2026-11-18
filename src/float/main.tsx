import { render } from "preact";
import { Launcher, events } from "../mygo";
import { PluginFrame } from "../shared/pluginframe";
import { applyAppearance } from "../shared/theme";

// 扩展的悬浮窗：一个透明的窗口，里面只有扩展的页面。关闭、挪动都由扩展自己通过 pocket.window 来做。
const params = new URLSearchParams(location.search);
const plugin = params.get("p") ?? "";
const tool = params.get("t") ?? "";
const url = params.get("u") ?? "";

// 主题属性要挂在这个页面上，扩展页面才拿得到（深浅色、强调色）。
void Promise.all([Launcher.info(), Launcher.config()]).then(([info, config]) => {
  applyAppearance(config, info);
  document.documentElement.style.background = "transparent";
  events.configChanged.on((c) => applyAppearance(c, info));
});

render(
  <PluginFrame plugin={plugin} tool={tool} url={url} float class="float-frame" title={tool} onClose={() => void Launcher.pluginCall(plugin, tool, "window.close", [])} />,
  document.getElementById("app")!,
);
