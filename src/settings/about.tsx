import { useEffect, useState } from "preact/hooks";
import { CheckCircle2, AlertCircle } from "lucide-preact";
import { Settings, type DoctorItem } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Row, Section } from "./ui";

export function About({ info, update }: SectionProps) {
  const [doctor, setDoctor] = useState<DoctorItem[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [problem, setProblem] = useState("");
  const check = () => void Settings.doctor().then(setDoctor);
  useEffect(check, []);
  // 从系统设置切回来时重新检查一遍，授权的结果马上能看到。
  useEffect(() => {
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  const reset = (kind: string) => {
    setProblem("");
    void Settings.resetPermission(kind).then(check, (e: Error) => setProblem(e.message));
  };

  return (
    <>
      <Section>
        <Row label="Yojigen Pocket" description={`版本 ${info.version || "开发版"} · 基于 mygo 构建`} />
        <Row label="配置目录" description={info.paths.home}>
          <Button onClick={() => void Settings.openFolder("home")}>打开</Button>
        </Row>
      </Section>

      <Section title="环境检查" description={problem || "脚本需要的解释器和系统权限。"} actions={<Button onClick={check}>重新检查</Button>}>
        {doctor.map((d) => (
          <div class="st-doctor" key={d.title}>
            {d.ok ? <CheckCircle2 size={17} class="st-ok" /> : <AlertCircle size={17} class="st-warn" />}
            <div class="st-item-text">
              <div class="st-row-label">{d.title}</div>
              <div class="st-row-desc">{d.detail}</div>
            </div>
            {d.action === "accessibility" && (
              <span class="st-inline">
                <Button onClick={() => void Settings.openAccessibility()}>去授权</Button>
                <Button title="清掉系统里旧的授权记录，然后重新授权" onClick={() => reset("accessibility")}>重置</Button>
              </span>
            )}
            {d.action === "screen" && (
              <span class="st-inline">
                <Button onClick={() => void Settings.openScreenCapture()}>去授权</Button>
                <Button title="清掉系统里旧的授权记录，然后重新授权" onClick={() => reset("screen")}>重置</Button>
                <Button onClick={() => void Settings.relaunch()}>重启应用</Button>
              </span>
            )}
            {d.action === "disk" && (
              <span class="st-inline">
                <Button onClick={() => void Settings.openFullDisk()}>去授权</Button>
                <Button onClick={() => void Settings.relaunch()}>重启应用</Button>
              </span>
            )}
          </div>
        ))}
      </Section>

      <Section title="重置">
        <Row label="清空使用记录" description="排序回到初始状态，固定的项目会保留">
          <Button
            onClick={() => {
              void Settings.clearUsage();
              setCleared(true);
            }}
          >
            {cleared ? "已清空" : "清空"}
          </Button>
        </Row>
        <Row label="恢复默认设置" description="脚本、插件和片段不受影响">
          {confirmReset ? (
            <span class="st-inline">
              <Button onClick={() => setConfirmReset(false)}>取消</Button>
              <Button
                danger
                onClick={() => {
                  setConfirmReset(false);
                  void Settings.reset().then((v) => update((c) => Object.assign(c, v.config)));
                }}
              >
                确定恢复
              </Button>
            </span>
          ) : (
            <Button onClick={() => setConfirmReset(true)}>恢复</Button>
          )}
        </Row>
      </Section>
    </>
  );
}
