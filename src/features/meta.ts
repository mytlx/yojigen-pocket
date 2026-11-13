/** 功能页的标题和图标（从一个功能页跳到另一个时用）。和 Go 里的 FeatureDefs 保持一致。 */
export const featureTitles: Record<string, string> = {
  calc: "计算器", clipboard: "剪贴板历史", find: "高级搜索", wintools: "Windows 工具",
  translate: "翻译", ocr: "图片文字识别", reader: "摸鱼阅读", json: "JSON 工具", codec: "编码转换", hash: "哈希计算",
  timestamp: "时间戳转换", regex: "正则测试", jwt: "JWT 解析", diff: "文本对比", random: "UUID 与密码", color: "颜色转换",
  urlparse: "URL 解析", text: "文本处理",
};

export const featureIcons: Record<string, string> = {
  calc: "svg:calculator", clipboard: "svg:clipboard", find: "svg:search", wintools: "svg:wrench",
  translate: "svg:languages", ocr: "svg:scan-text", reader: "svg:book-open", json: "svg:braces", codec: "svg:binary",
  hash: "svg:fingerprint", timestamp: "svg:clock", regex: "svg:regex", jwt: "svg:key-round", diff: "svg:diff",
  random: "svg:dices", color: "svg:palette", urlparse: "svg:link", text: "svg:case-sensitive",
};
