import { useEffect, useRef } from "preact/hooks";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-preact";
import { Btn } from "../../../../src/features/ui";
import type { FindQuery, FindStats } from "./findreplace";

export interface FindReplaceBarProps {
  query: FindQuery;
  replaceText: string;
  showReplace: boolean;
  canReplace: boolean;
  stats: FindStats;
  focusNonce: number;
  onChangeQuery: (patch: Partial<FindQuery>) => void;
  onChangeReplaceText: (text: string) => void;
  onToggleReplace: () => void;
  onNext: () => void;
  onPrev: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/** 统一浮动查找/替换条（VS Code / Typora 风格），覆盖阅读、实时、整块与源码四种模式。 */
export function FindReplaceBar(props: FindReplaceBarProps) {
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = findInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [props.focusNonce]);

  const { query, stats, canReplace } = props;
  const replaceVisible = canReplace && props.showReplace;

  const counterText = stats.error
    ? "正则无效"
    : !query.query
      ? ""
      : stats.total === 0
        ? "无结果"
        : `${stats.current} / ${stats.total}`;

  return (
    <div
      class={`fx-find-bar${replaceVisible ? " has-replace" : ""}${stats.error ? " is-error" : ""}`}
      role="search"
      aria-label="查找和替换"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      {canReplace && (
        <button
          type="button"
          class="fx-find-expand"
          title={replaceVisible ? "收起替换" : "展开替换"}
          aria-label={replaceVisible ? "收起替换" : "展开替换"}
          aria-expanded={replaceVisible}
          onClick={props.onToggleReplace}
        >
          {replaceVisible ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      )}
      <div class="fx-find-rows">
        <div class="fx-find-row">
          <div class="fx-find-input-wrap">
            <input
              ref={findInputRef}
              class="fx-find-input"
              placeholder="查找…"
              aria-label="查找内容"
              value={query.query}
              spellcheck={false}
              onInput={(e) => props.onChangeQuery({ query: (e.target as HTMLInputElement).value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault();
                  if (e.shiftKey) props.onPrev();
                  else props.onNext();
                }
              }}
            />
            <div class="fx-find-flags">
              <button
                type="button"
                class={`fx-find-flag${query.caseSensitive ? " is-on" : ""}`}
                title="区分大小写"
                aria-label="区分大小写"
                aria-pressed={query.caseSensitive}
                onClick={() => props.onChangeQuery({ caseSensitive: !query.caseSensitive })}
              >
                <CaseSensitive size={13} />
              </button>
              <button
                type="button"
                class={`fx-find-flag${query.wholeWord ? " is-on" : ""}`}
                title="全词匹配"
                aria-label="全词匹配"
                aria-pressed={query.wholeWord}
                onClick={() => props.onChangeQuery({ wholeWord: !query.wholeWord })}
              >
                <WholeWord size={13} />
              </button>
              <button
                type="button"
                class={`fx-find-flag${query.regex ? " is-on" : ""}`}
                title="使用正则表达式"
                aria-label="使用正则表达式"
                aria-pressed={query.regex}
                onClick={() => props.onChangeQuery({ regex: !query.regex })}
              >
                <Regex size={13} />
              </button>
            </div>
          </div>
          <span class={`fx-find-count${stats.error || (query.query && stats.total === 0) ? " is-empty" : ""}`} title={stats.error}>
            {counterText}
          </span>
          <Btn small ghost icon title="上一个 (Shift+Enter)" disabled={stats.total === 0} onClick={props.onPrev}>
            <ArrowUp size={13} />
          </Btn>
          <Btn small ghost icon title="下一个 (Enter)" disabled={stats.total === 0} onClick={props.onNext}>
            <ArrowDown size={13} />
          </Btn>
          <Btn small ghost icon title="关闭 (Esc)" onClick={props.onClose}>
            <X size={13} />
          </Btn>
        </div>

        {replaceVisible && (
          <div class="fx-find-row">
            <div class="fx-find-input-wrap">
              <input
                ref={replaceInputRef}
                class="fx-find-input"
                placeholder="替换为…"
                aria-label="替换为"
                value={props.replaceText}
                spellcheck={false}
                onInput={(e) => props.onChangeReplaceText((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.isComposing) {
                    e.preventDefault();
                    if (e.ctrlKey || e.metaKey) props.onReplaceAll();
                    else props.onReplaceOne();
                  }
                }}
              />
            </div>
            <Btn small ghost icon title="替换当前 (Enter)" disabled={stats.total === 0} onClick={props.onReplaceOne}>
              <Replace size={13} />
            </Btn>
            <Btn small ghost icon title="全部替换 (Ctrl+Enter)" disabled={stats.total === 0} onClick={props.onReplaceAll}>
              <ReplaceAll size={13} />
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}
