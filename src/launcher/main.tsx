import { render } from "preact";
import "../shared/tokens.css";
import "../shared/motion.css";
import "../shared/controls.css";
import "./launcher.css";
import { App } from "./app";

render(<App />, document.getElementById("app")!);
