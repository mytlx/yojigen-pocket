import { useEffect, useState } from "preact/hooks";
import { CheckCircle2 } from "lucide-preact";
import { OCR, Settings, Translator } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Row, Section, Segmented, Text, Toggle } from "./ui";

const KEY = { claude: "translate.claude", openai: "translate.openai", youdao: "translate.youdao", baidu: "translate.baidu" } as const;

/** 密钥输入：只写不读。保存到系统的凭据管理器，界面上只显示有没有填。 */
function SecretField({ name, saved, onSaved, placeholder }: { name: string; saved: boolean; onSaved: () => void; placeholder: string }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const save = async () => {
    if (!value.trim()) return;
    setState("saving");
    try {
      await Translator.setKey(name, value);
      setValue("");
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  };
  return (
    <span class="st-inline">
      <input
        class="st-input is-mono"
        style={{ width: "240px" }}
        type="password"
        value={value}
        placeholder={saved ? "已保存，输入新的可替换" : placeholder}
        autocomplete="off"
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && void save()}
        onBlur={() => void save()}
      />
      {saved && state !== "error" ? <CheckCircle2 size={16} class="st-ok" /> : null}
      {saved && (
        <Button onClick={() => void Translator.setKey(name, "").then(onSaved)} title="删除保存的密钥">
          清除
        </Button>
      )}
      {state === "error" && <span class="st-row-error">保存失败</span>}
    </span>
  );
}

export function TranslateSettings({ info, config, update }: SectionProps) {
  const t = config.translate;
  const set = (fn: (x: typeof t) => void) => update((c) => fn(c.translate));
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [test, setTest] = useState<{ text: string; error?: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [screenOK, setScreenOK] = useState(true);
  const refreshKeys = () => void Translator.keyStatus().then(setKeys);
  useEffect(() => {
    refreshKeys();
    void OCR.permission().then(setScreenOK);
  }, []);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest({ text: `可以用：Hello, world → ${await Translator.test(t.provider)}` });
    } catch (e) {
      setTest({ text: (e as Error).message, error: true });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Section title="翻译服务" description="密钥保存在系统的凭据管理器（钥匙串 / Windows 凭据管理器）里，不写进配置文件，同步配置目录时不会泄露。">
        <Row label="使用">
          <Segmented
            value={t.provider as "claude" | "openai" | "youdao" | "baidu"}
            options={[
              { value: "claude", label: "Claude" },
              { value: "openai", label: "OpenAI 兼容" },
              { value: "youdao", label: "有道智云" },
              { value: "baidu", label: "百度翻译" },
            ]}
            onChange={(v) => set((x) => (x.provider = v))}
          />
        </Row>
        {t.provider === "claude" && (
          <>
            <Row label="API 密钥" description="在 console.anthropic.com 创建">
              <SecretField name={KEY.claude} saved={!!keys[KEY.claude]} onSaved={refreshKeys} placeholder="sk-ant-…" />
            </Row>
            <Row label="模型" description="默认 claude-opus-5-5；想更快更省可以换成 claude-haiku-5-5">
              <Text value={t.claude.model} width={240} mono onChange={(v) => set((x) => (x.claude.model = v.trim()))} />
            </Row>
            <Row label="接口地址" description="留空使用官方地址；用代理或转发服务时填写">
              <Text value={t.claude.baseUrl ?? ""} width={240} mono placeholder="https://api.anthropic.com" onChange={(v) => set((x) => (x.claude.baseUrl = v.trim()))} />
            </Row>
          </>
        )}
        {t.provider === "openai" && (
          <>
            <Row label="接口地址" description="兼容 OpenAI 的接口：DeepSeek、通义千问、Kimi、智谱、本地 Ollama（http://localhost:11434/v1）等">
              <Text value={t.openai.baseUrl ?? ""} width={280} mono placeholder="https://api.openai.com/v1" onChange={(v) => set((x) => (x.openai.baseUrl = v.trim()))} />
            </Row>
            <Row label="模型" description="填服务商给的模型名称">
              <Text value={t.openai.model} width={240} mono placeholder="例如 deepseek-chat" onChange={(v) => set((x) => (x.openai.model = v.trim()))} />
            </Row>
            <Row label="API 密钥" description="本地 Ollama 可以随便填一个">
              <SecretField name={KEY.openai} saved={!!keys[KEY.openai]} onSaved={refreshKeys} placeholder="sk-…" />
            </Row>
          </>
        )}
        {t.provider === "youdao" && (
          <>
            <Row label="应用 ID" description="在有道智云 ai.youdao.com 创建「文本翻译」应用">
              <Text value={t.youdaoAppKey ?? ""} width={240} mono onChange={(v) => set((x) => (x.youdaoAppKey = v.trim()))} />
            </Row>
            <Row label="应用密钥">
              <SecretField name={KEY.youdao} saved={!!keys[KEY.youdao]} onSaved={refreshKeys} placeholder="应用密钥" />
            </Row>
          </>
        )}
        {t.provider === "baidu" && (
          <>
            <Row label="APP ID" description="在百度翻译开放平台 fanyi-api.baidu.com 申请">
              <Text value={t.baiduAppId ?? ""} width={240} mono onChange={(v) => set((x) => (x.baiduAppId = v.trim()))} />
            </Row>
            <Row label="密钥">
              <SecretField name={KEY.baidu} saved={!!keys[KEY.baidu]} onSaved={refreshKeys} placeholder="密钥" />
            </Row>
          </>
        )}
        <Row label="试一下" description={test?.text} error={undefined}>
          <Button primary disabled={testing} onClick={() => void runTest()}>
            {testing ? "正在测试…" : "测试连接"}
          </Button>
        </Row>
        {test?.error && <div class="st-test-error">{test.text}</div>}
      </Section>

      <Section title="翻译选项">
        <Row label="翻译完自动朗读译文" description="用什么声音读，在左边的「发音」里设置">
          <Toggle label="自动朗读" checked={t.autoSpeak} onChange={(v) => set((x) => (x.autoSpeak = v))} />
        </Row>
      </Section>

      <Section title="截图识别文字">
        <Row label="识别引擎" description="系统识别离线、免费、速度快；大模型识别对排版复杂的图片更准，会用上面填写的接口">
          <Segmented
            value={config.ocr.engine as "system" | "claude" | "openai"}
            options={[
              { value: "system", label: "系统离线" },
              { value: "claude", label: "Claude" },
              { value: "openai", label: "OpenAI 兼容" },
            ]}
            onChange={(v) => update((c) => (c.ocr.engine = v))}
          />
        </Row>
        {config.ocr.engine === "system" && (
          <Row label="识别的语言" description="系统离线识别用。中文模式同时认英文和数字">
            <Segmented
              value={config.ocr.language as "zh" | "en" | "ja" | "ko"}
              options={[
                { value: "zh", label: "中文 + 英文" },
                { value: "en", label: "英文" },
                { value: "ja", label: "日文" },
                { value: "ko", label: "韩文" },
              ]}
              onChange={(v) => update((c) => (c.ocr.language = v))}
            />
          </Row>
        )}
        {info.platform === "darwin" && (
          <Row label="屏幕录制权限" description={screenOK ? "已授权" : "截图识别需要它。授权后要重启本应用才生效；识别剪贴板里的图片不需要"}>
            {screenOK ? (
              <CheckCircle2 size={18} class="st-ok" />
            ) : (
              <span class="st-inline">
                <Button onClick={() => void OCR.requestPermission()}>去授权</Button>
                <Button onClick={() => void Settings.relaunch()}>重启应用</Button>
              </span>
            )}
          </Row>
        )}
        {info.platform === "windows" && <Row label="说明" description="Windows 用系统自带的截图工具框选；离线识别需要在「时间和语言 → 语言」里为中文装上「光学字符识别」" />}
      </Section>
    </>
  );
}
