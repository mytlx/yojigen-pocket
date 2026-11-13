import { useEffect, useState } from "preact/hooks";
import { CheckCircle2, AlertCircle } from "lucide-preact";
import { Settings, type DoctorItem } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Row, Section } from "./ui";

export function About({ info, update }: SectionProps) {
  const [doctor, setDoctor] = useState<DoctorItem[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [cleared, setCleared] = useState(false);
  const check = () => void Settings.doctor().then(setDoctor);
  useEffect(check, []);

  return (
    <>
      <Section>
        <Row label="Yojigen Pocket" description={`版本 ${info.version || "开发版"} · 基于 mygo 构建`} />
        <Row label="配置目录" description={info.paths.home}>
          <Button onClick={() => void Settings.openFolder("home")}>打开</Button>
        </Row>
      </Section>

      <Section title="环境检查" description="脚本需要的解释器和系统权限。" actions={<Button onClick={check}>重新检查</Button>}>
        {doctor.map((d) => (
          <div class="st-doctor" key={d.title}>
            {d.ok ? <CheckCircle2 size={17} class="st-ok" /> : <AlertCircle size={17} class="st-warn" />}
            <div class="st-item-text">
              <div class="st-row-label">{d.title}</div>
              <div class="st-row-desc">{d.detail}</div>
            </div>
            {d.action === "accessibility" && <Button onClick={() => void Settings.openAccessibility()}>去授权</Button>}
            {d.action === "screen" && <Button onClick={() => void Settings.openScreenCapture()}>去授权</Button>}
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
