import { render } from "preact";
import "../shared/tokens.css";
import "../shared/motion.css";
import "../shared/controls.css";
import "./launcher.css";
import { App } from "./app";
import { installTooltips } from "../shared/tooltip";
import { installZoom } from "../shared/zoom";

installTooltips();
installZoom();

render(<App />, document.getElementById("app")!);
