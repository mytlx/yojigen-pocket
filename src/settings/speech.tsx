import { useEffect, useRef, useState } from "preact/hooks";
import { CheckCircle2 } from "lucide-preact";
import { Speech, type EdgeVoiceInfo, type SpeechStatus } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Row, Section, Segmented, Slider, Text } from "./ui";

const langs: [string, string][] = [
  ["zh", "中文"], ["en", "英语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"], ["de", "德语"], ["es", "西班牙语"], ["ru", "俄语"],
];

type Note = { text: string; error?: boolean } | null;

/** 试听：合成一句并播放，失败时把原因显示出来。 */
function useTest() {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<Note>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const run = async (engine: string) => {
    audio.current?.pause();
    setBusy(engine);
    setNote(null);
    try {
      const r = await Speech.test(engine);
      if (r.url) {
        audio.current = new Audio(r.url);
        await audio.current.play();
      }
      setNote({ text: "可以用，正在播放" });
    } catch (e) {
      setNote({ text: (e as Error).message, error: true });
    } finally {
      setBusy("");
    }
  };
  return { busy, note, run };
}

export function SpeechSettings({ config, update }: SectionProps) {
  const s = config.speech;
  const set = (fn: (x: typeof s) => void) => update((c) => fn(c.speech));
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [voices, setVoices] = useState<EdgeVoiceInfo[]>([]);
  const [voiceNote, setVoiceNote] = useState<Note>(null);
  const [profileNote, setProfileNote] = useState<Note>(null);
  const [install, setInstall] = useState<{ busy: boolean; log?: string; error?: string }>({ busy: false });
  const [key, setKey] = useState("");
  const test = useTest();
  const refresh = () => void Speech.status().then(setStatus);
  useEffect(refresh, []);

  const loadVoices = async () => {
    setVoiceNote({ text: "正在获取…" });
    try {
      const list = await Speech.voices();
      setVoices(list);
      setVoiceNote({ text: `拿到 ${list.length} 个音色，在下面的输入框里可以直接选` });
    } catch (e) {
      setVoiceNote({ text: (e as Error).message, error: true });
    }
  };
  const act = async (fn: () => Promise<SpeechStatus>, ok: string) => {
    try {
      setStatus(await fn());
      setProfileNote({ text: ok });
    } catch (e) {
      setProfileNote({ text: (e as Error).message, error: true });
      refresh();
    }
  };
  const runInstall = async () => {
    setInstall({ busy: true });
    try {
      setInstall({ busy: false, log: await Speech.installCommand() });
    } catch (e) {
      setInstall({ busy: false, error: (e as Error).message });
    }
    refresh();
  };
  const saveKey = async () => {
    if (!key.trim()) return;
    await Speech.setKey(key);
    setKey("");
    refresh();
  };
  const testButton = (engine: string) => (
    <Button disabled={!!test.busy} onClick={() => void test.run(engine)}>
      {test.busy === engine ? "合成中…" : "试听"}
    </Button>
  );

  return (
    <>
      <Section title="发音" description="朗读用什么声音。和翻译用哪个服务没有关系：翻译可以用百度，发音照样用下面选的。">
        <Row label="单个英文单词" description="词典的真人发音，查不到或连不上时自动换另一个，再不行用下面的句子引擎">
          <span class="st-inline">
            <Segmented
              value={s.word as "youdao" | "google" | "sentence"}
              options={[
                { value: "youdao", label: "有道" },
                { value: "google", label: "谷歌" },
                { value: "sentence", label: "和句子一样" },
              ]}
              onChange={(v) => set((x) => (x.word = v))}
            />
            {s.word !== "sentence" && testButton(s.word)}
          </span>
        </Row>
        {s.word !== "sentence" && (
          <Row label="英语口音">
            <Segmented
              value={s.accent as "us" | "uk"}
              options={[
                { value: "us", label: "美音" },
                { value: "uk", label: "英音" },
              ]}
              onChange={(v) => set((x) => (x.accent = v))}
            />
          </Row>
        )}
        <Row label="句子和长文本" description="Edge 语音自然、免费，需要联网；系统语音不联网但比较生硬">
          <span class="st-inline">
            <Segmented
              value={s.sentence as "edge" | "system" | "openai" | "kokoro"}
              options={[
                { value: "edge", label: "Edge 语音" },
                { value: "system", label: "系统语音" },
                { value: "openai", label: "语音接口" },
                { value: "kokoro", label: "本地 Kokoro" },
              ]}
              onChange={(v) => set((x) => (x.sentence = v))}
            />
            {testButton(s.sentence)}
          </span>
        </Row>
        <Row label="语速" description="0 是正常速度">
          <Slider value={s.rate} min={-50} max={100} step={5} unit="%" onChange={(v) => set((x) => (x.rate = v))} />
        </Row>
        {test.note && <div class={test.note.error ? "st-test-error" : "st-test-ok"}>{test.note.text}</div>}
      </Section>

      {s.sentence === "edge" && (
        <>
          <Section title="Edge 语音的音色" description="按语言分别选。音色名形如 zh-CN-XiaoxiaoNeural；名字里带 Multilingual 的能读多种语言。">
            <Row label="全部音色" description={voiceNote?.text} error={voiceNote?.error ? voiceNote.text : undefined}>
              <Button onClick={() => void loadVoices()}>获取音色列表</Button>
            </Row>
            {langs.map(([code, name]) => (
              <Row label={name} key={code}>
                <input
                  class="st-input is-mono"
                  style={{ width: "300px" }}
                  list={`voices-${code}`}
                  value={s.edge.voices?.[code] ?? ""}
                  spellcheck={false}
                  onChange={(e) => {
                    const v = (e.target as HTMLInputElement).value.trim();
                    set((x) => (x.edge.voices = { ...(x.edge.voices ?? {}), [code]: v }));
                  }}
                />
                <datalist id={`voices-${code}`}>
                  {voices
                    .filter((v) => v.locale.toLowerCase().startsWith(code) || v.name.includes("Multilingual"))
                    .map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.gender === "Female" ? "女声" : "男声"} · {v.locale}
                      </option>
                    ))}
                </datalist>
              </Row>
            ))}
          </Section>

          <Section
            title="Edge 语音的连接方式"
            description="这个接口没有公开文档，微软隔一阵会改校验方式，一改内置的实现就连不上。所以留了三条路：内置实现的参数可以在线更新或手改；也可以交给外部的 edge-tts 命令，它由社区维护，升级它就行，不用等本应用更新。"
          >
            <Row label="怎么连" description="自动：先用内置实现，连不上再试外部命令">
              <Segmented
                value={(s.edge.mode || "auto") as "auto" | "builtin" | "command"}
                options={[
                  { value: "auto", label: "自动" },
                  { value: "builtin", label: "只用内置" },
                  { value: "command", label: "只用外部命令" },
                ]}
                onChange={(v) => set((x) => (x.edge.mode = v))}
              />
            </Row>
            <Row
              label="内置实现的参数"
              description={
                status
                  ? `${status.profileCustom ? "正在用自定义的参数文件" : "正在用内置参数"} · ${status.profileUpdated} · Chromium ${status.chromium} · 签名 ${status.gec}`
                  : ""
              }
            >
              <span class="st-inline">
                <Button onClick={() => void Speech.editProfile().then(refresh)}>编辑参数文件</Button>
                {status?.profileCustom && <Button onClick={() => void act(Speech.resetProfile, "已恢复内置参数")}>恢复内置</Button>}
              </span>
            </Row>
            <Row label="参数的更新地址" description="一个返回参数 JSON 的网址（格式和参数文件一样）。校验方式变了时，把别人更新好的参数拉下来">
              <span class="st-inline">
                <Text value={s.edge.profileUrl ?? ""} width={300} mono placeholder="https://…/edge-tts.json" onChange={(v) => set((x) => (x.edge.profileUrl = v.trim()))} />
                <Button disabled={!s.edge.profileUrl} onClick={() => void act(Speech.updateProfile, "参数已更新")}>
                  立即更新
                </Button>
              </span>
            </Row>
            {profileNote && <div class={profileNote.error ? "st-test-error" : "st-test-ok"}>{profileNote.text}</div>}
            <Row label="外部命令" description={status?.command ? `已找到：${status.command}` : "还没有找到。可以点右边安装（需要电脑上有 Python），或者自己运行 pip install edge-tts"}>
              <span class="st-inline">
                <Text value={s.edge.command ?? ""} width={200} mono placeholder="edge-tts" onChange={(v) => set((x) => (x.edge.command = v.trim()))} />
                {status?.command && <CheckCircle2 size={16} class="st-ok" />}
                <Button disabled={install.busy} onClick={() => void runInstall()}>
                  {install.busy ? "正在安装…" : status?.command ? "升级" : "安装"}
                </Button>
              </span>
            </Row>
            {install.error && <div class="st-test-error">{install.error}</div>}
            {install.log && <pre class="st-log">{install.log}</pre>}
          </Section>
        </>
      )}

      {s.sentence === "openai" && (
        <Section title="语音接口" description="兼容 OpenAI 的语音合成接口（/audio/speech）。密钥和翻译的分开保存。">
          <Row label="接口地址">
            <Text value={s.openai.baseUrl ?? ""} width={300} mono placeholder="https://api.openai.com/v1" onChange={(v) => set((x) => (x.openai.baseUrl = v.trim()))} />
          </Row>
          <Row label="模型">
            <Text value={s.openai.model ?? ""} width={220} mono placeholder="gpt-4o-mini-tts" onChange={(v) => set((x) => (x.openai.model = v.trim()))} />
          </Row>
          <Row label="音色">
            <Text value={s.openai.voice ?? ""} width={220} mono placeholder="alloy" onChange={(v) => set((x) => (x.openai.voice = v.trim()))} />
          </Row>
          <Row label="API 密钥" description="保存在系统的凭据管理器里">
            <span class="st-inline">
              <input
                class="st-input is-mono"
                style={{ width: "240px" }}
                type="password"
                value={key}
                placeholder={status?.keySet ? "已保存，输入新的可替换" : "sk-…"}
                autocomplete="off"
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === "Enter" && void saveKey()}
                onBlur={() => void saveKey()}
              />
              {status?.keySet && <CheckCircle2 size={16} class="st-ok" />}
              {status?.keySet && <Button onClick={() => void Speech.setKey("").then(refresh)}>清除</Button>}
            </span>
          </Row>
        </Section>
      )}

      {s.sentence === "kokoro" && (
        <Section
          title="本地 Kokoro"
          description="Kokoro-82M 是一个可以在自己电脑上跑的开源语音模型。用 Kokoro-FastAPI 之类的项目部署后，它提供和 OpenAI 一样的接口，把地址填在这里就能用，不需要密钥，也不联网。还没部署时这里填了也不会生效，朗读会退回系统语音。"
        >
          <Row label="接口地址" description="Kokoro-FastAPI 默认是 http://127.0.0.1:8880/v1">
            <Text value={s.kokoro.baseUrl ?? ""} width={300} mono placeholder="http://127.0.0.1:8880/v1" onChange={(v) => set((x) => (x.kokoro.baseUrl = v.trim()))} />
          </Row>
          <Row label="模型">
            <Text value={s.kokoro.model ?? ""} width={220} mono placeholder="kokoro" onChange={(v) => set((x) => (x.kokoro.model = v.trim()))} />
          </Row>
          <Row label="音色" description="例如 af_heart（英语女声）、zf_xiaobei（中文女声）；可以用加号混合，如 af_heart+zf_xiaobei">
            <Text value={s.kokoro.voice ?? ""} width={220} mono placeholder="af_heart" onChange={(v) => set((x) => (x.kokoro.voice = v.trim()))} />
          </Row>
        </Section>
      )}
    </>
  );
}
