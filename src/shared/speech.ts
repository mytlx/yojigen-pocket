import { Speech, type SpeechResult } from "../mygo";

/**
 * 朗读。长文本由后端切成段，这里一段一段地合成和播放：第一段合成好就开始出声，
 * 播放的同时预先合成下一段，句子之间不会卡住。
 *
 * 引擎由设置里的“发音”决定（和翻译用哪个服务无关）；合成不出来时后端会说明原因，这里改用系统语音。
 */

let token = 0;
let audio: HTMLAudioElement | null = null;
let usingSystem = false;

export interface SpeakOptions {
  /** 全部读完，或被 stopSpeaking 打断。 */
  onEnd?: () => void;
  /** 首选的引擎用不了、换了别的时的说明（只说一次）。 */
  onNote?: (note: string) => void;
}

/** 停止当前的朗读。 */
export function stopSpeaking() {
  token++;
  if (audio) {
    audio.onended = audio.onerror = null;
    audio.pause();
    audio = null;
  }
  if (usingSystem) {
    usingSystem = false;
    void Speech.stop();
  }
}

function play(url: string, my: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (my !== token) return resolve();
    const el = new Audio(url);
    audio = el;
    el.onended = () => resolve();
    el.onerror = () => reject(new Error("音频播放失败"));
    el.play().catch(reject);
  });
}

/** 朗读一段文字。lang 是 zh、en、ja 这样的语言代码。 */
export async function speak(text: string, lang: string, opts: SpeakOptions = {}): Promise<void> {
  stopSpeaking();
  const my = ++token;
  const finish = () => {
    if (my === token) opts.onEnd?.();
  };
  try {
    const { segments } = await Speech.plan(text, lang);
    if (my !== token) return;
    const list = segments ?? [];
    let noted = false;
    let next: Promise<SpeechResult> | null = list.length ? Speech.synthesize(list[0]!, lang) : null;
    for (let i = 0; i < list.length && next; i++) {
      const res = await next;
      if (my !== token) return;
      if (res.note && !noted) {
        noted = true;
        opts.onNote?.(res.note);
      }
      if (!res.url) {
        // 合成不出来：剩下的全部交给系统语音，一口气读完。
        usingSystem = true;
        await Speech.speakSystem(list.slice(i).join(" "), lang);
        if (my === token) usingSystem = false;
        break;
      }
      // 这一段播放的时候，下一段已经在合成了。
      next = i + 1 < list.length ? Speech.synthesize(list[i + 1]!, lang) : null;
      next?.catch(() => undefined);
      await play(res.url, my);
      if (my !== token) return;
    }
  } finally {
    finish();
  }
}
