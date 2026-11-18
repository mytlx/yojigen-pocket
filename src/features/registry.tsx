import type { FunctionComponent } from "preact";
import type { FeatureProps } from "./types";
import { HashTool } from "./hash";
import { CodecTool } from "./codec";
import { JsonTool } from "./json";
import { TimestampTool } from "./timestamp";
import { RegexTool } from "./regex";
import { JwtTool } from "./jwt";
import { RandomTool } from "./random";
import { ColorTool } from "./color";
import { UrlTool } from "./urlparse";
import { TextTool } from "./text";
import { TranslateTool } from "./translate";
import { OcrTool } from "./ocr";
import { ReaderTool } from "./reader";
import { CalcTool } from "./calc";
import { ClipboardTool } from "./clipboard";
import { FindTool } from "./find";
import { WinToolsPage } from "./wintools";
import { ClickerTool } from "./clicker";
import { MacroTool } from "./macro";
import { InputTest } from "./inputtest";

import "./features.css";

/** 功能页：组件和它在主窗口里的高度。 */
export const features: Record<string, { component: FunctionComponent<FeatureProps>; height: number }> = {
  translate: { component: TranslateTool, height: 440 },
  ocr: { component: OcrTool, height: 460 },
  reader: { component: ReaderTool, height: 540 },
  calc: { component: CalcTool, height: 440 },
  clipboard: { component: ClipboardTool, height: 480 },
  find: { component: FindTool, height: 540 },
  wintools: { component: WinToolsPage, height: 500 },
  json: { component: JsonTool, height: 480 },
  codec: { component: CodecTool, height: 420 },
  hash: { component: HashTool, height: 420 },
  timestamp: { component: TimestampTool, height: 470 },
  regex: { component: RegexTool, height: 520 },
  jwt: { component: JwtTool, height: 480 },
  clicker: { component: ClickerTool, height: 520 },
  macro: { component: MacroTool, height: 580 },
  inputtest: { component: InputTest, height: 470 },
  random: { component: RandomTool, height: 440 },
  color: { component: ColorTool, height: 420 },
  urlparse: { component: UrlTool, height: 440 },
  text: { component: TextTool, height: 440 },
};
