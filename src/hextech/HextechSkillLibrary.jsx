import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { HEXTECH_SKILLS } from "../../shared/hextech.js";
import "./skill-library.css";
import { skillImage, skillImageSrcSet } from "./hextech-assets.js";

const KIND_META = Object.freeze({
  active: { label: "主动", description: "在合法时机由你选择是否发动" },
  passive: { label: "被动", description: "装备后在触发条件满足时自动生效" },
  reaction: { label: "反应", description: "事件发生时进入确认窗口" },
});

const RARITIES = Object.freeze(["普通", "稀有", "金色"]);

const STREET_LABELS = Object.freeze({
  preflop: "翻牌前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
});

const TARGET_LABELS = Object.freeze({
  none: "无需指定目标",
  self: "自己",
  opponent: "符合条件的对手",
  "own-hole-card": "自己的底牌",
  global: "全桌",
});

const TARGET_FILTER_LABELS = Object.freeze({
  seated: "已入座",
  "active-in-hand": "仍在本手",
  "has-hole-cards": "持有底牌",
  "can-call": "可以跟注",
  "can-raise": "可以加注",
  "unused-active-equipment": "主动装备尚未使用",
  "non-blank-hole-card": "非白板底牌",
  "triggered-check-raise": "刚触发过牌加注",
  "all-active-players": "所有仍在本手的玩家",
});

const DESTINATION_LABELS = Object.freeze({
  pot: "底池",
  bank: "银行",
  escrow: "托管区",
});

const COUNTERPLAY_LABELS = Object.freeze({
  shield: "技能护盾",
  mirror: "反弹镜",
  "smoke-bomb": "烟雾弹",
  "fake-weak": "装糖阴你一手",
  "fake-strong": "装阴糖你一手",
  escape: "金蝉脱壳",
});

const PROBABILITY_LABELS = Object.freeze({
  success: "成功",
  failure: "失败",
  "chosen-rank": "变成指定点数",
  "small-rank": "变成小点数",
  unchanged: "不变",
  blank: "变成白板",
});

function formatChips(value) {
  return Number(value).toLocaleString("zh-CN");
}

function formatPercent(value) {
  const percentage = Number(value) * 100;
  return `${Number.isInteger(percentage) ? percentage : percentage.toFixed(1)}%`;
}

export { skillImage } from "./hextech-assets.js";

export function activationKind(skill) {
  return skill?.rules?.activation?.kind ?? "active";
}

export function formatSkillTarget(target) {
  if (!target || target.type === "none") return "无需指定目标";
  const base = TARGET_LABELS[target.type] ?? target.type;
  const unit = target.type === "own-hole-card" ? "张" : "名";
  const count = target.type === "self" || target.type === "global"
    ? ""
    : target.minimum === target.maximum && target.minimum > 0
      ? `${target.minimum} ${unit}`
      : target.maximum > 0
        ? `${target.minimum}–${target.maximum} ${unit}`
        : "";
  const filters = (target.filters ?? []).map((filter) => TARGET_FILTER_LABELS[filter] ?? filter);
  return [count, base, filters.length ? `（${filters.join("、")}）` : ""].filter(Boolean).join(" ");
}

export function formatSkillCost(cost) {
  if (!cost) return "无固定筹码代价";
  if (cost.type === "fixed") {
    return `支付 ${formatChips(cost.amount)} 筹码至${DESTINATION_LABELS[cost.destination] ?? cost.destination}`;
  }
  if (cost.type === "clamped-ratio") {
    return `支付剩余筹码的 ${formatPercent(cost.ratio)}，最低 ${formatChips(cost.minimum)}、最高 ${formatChips(cost.maximum)}，计入${DESTINATION_LABELS[cost.destination] ?? cost.destination}`;
  }
  if (cost.type === "lock-stack") {
    return `锁定 ${formatChips(cost.amount)} 筹码至${DESTINATION_LABELS[cost.destination] ?? cost.destination}`;
  }
  return "按当前技能规则结算";
}

function formatSkillRisk(rules) {
  return rules.maximumChipRisk > 0
    ? `最多 ${formatChips(rules.maximumChipRisk)} 筹码`
    : "规则未设额外筹码风险";
}

function formatSkillCounterplay(rules) {
  if (rules.counterplay?.length) {
    return rules.counterplay.map((item) => COUNTERPLAY_LABELS[item] ?? item).join("、");
  }
  if (rules.defense) {
    if (rules.defense.type === "block") return "本技能用于抵挡第一个指向你的公共技能";
    if (rules.defense.type === "reflect-or-block") return "本技能可反弹合法目标，否则抵挡该技能";
    if (rules.defense.type === "force-view-failure") return "本技能使一次查看底牌的效果失败";
  }
  return "无直接反制技能";
}

function formatSkillStreets(rules) {
  const streets = rules.activation?.legalStreets ?? [];
  if (streets.length === 4) return "翻牌前、翻牌、转牌、河牌";
  return streets.map((street) => STREET_LABELS[street] ?? street).join("、") || "按触发窗口";
}

function formatSkillUsage(rules) {
  const usage = rules.usage;
  if (!usage) return "按技能触发窗口";
  const scope = usage.scope === "hand" ? "每手" : usage.scope === "match" ? "每场" : usage.scope;
  const owner = usage.owner === "table" ? "（全桌共享）" : "";
  return `${scope}最多 ${usage.limit} 次${owner}`;
}

function formatProbabilities(rules) {
  if (!rules.probabilities?.length) return null;
  return rules.probabilities
    .map(({ id, probability }) => `${PROBABILITY_LABELS[id] ?? id} ${formatPercent(probability)}`)
    .join(" · ");
}

export function buildSkillSteps(skill) {
  const rules = skill.rules;
  const kind = activationKind(skill);
  if (kind === "passive") {
    return [
      "在本手三选一中装备该技能。",
      `无需手动发动；系统会在「${skill.timing}」检查触发条件。`,
      "触发后由服务器按技能摘要结算效果。",
    ];
  }

  const steps = [kind === "reaction"
    ? `装备后等待「${skill.timing}」反应窗口。`
    : `在「${skill.timing}」的合法窗口打开技能操作。`];
  if (rules.target?.type && rules.target.type !== "none") {
    steps.push(`选择${formatSkillTarget(rules.target)}。`);
  }
  for (const choice of rules.choiceSchema?.steps ?? []) {
    steps.push(`完成选择：${choice.label}。`);
  }
  if (rules.cost) steps.push(`${formatSkillCost(rules.cost)}。`);
  if (rules.requiresConfirmation) steps.push("确认发动，服务器校验时机、目标与筹码后结算。");
  else steps.push("发动后由服务器校验并结算。");
  return steps;
}

function SkillCard({ skill }) {
  const rules = skill.rules;
  const kind = activationKind(skill);
  const probabilityText = formatProbabilities(rules);
  const detailId = `hextech-skill-detail-${skill.id}`;

  return (
    <article className={`hextech-library-card rarity-${skill.rarity}`} data-kind={kind}>
      <div className="hextech-library-card-heading">
        <span className="hextech-library-art" aria-hidden="true">
          <img src={skillImage(skill.id)} srcSet={skillImageSrcSet(skill.id)} sizes="74px" width="128" height="128" alt="" loading="lazy" decoding="async" />
        </span>
        <div>
          <span className="hextech-library-tags">
            <em>{skill.rarity}</em>
            <em>{KIND_META[kind]?.label ?? kind}</em>
            <em>{skill.cheat || rules.audit?.cheat ? "作弊" : "合法"}</em>
          </span>
          <h3>{skill.name}</h3>
          <small>{skill.category} · {skill.timing}</small>
        </div>
      </div>
      <p className="hextech-library-summary">{skill.summary}</p>
      <details className="hextech-library-details" id={detailId}>
        <summary>
          <span>查看完整使用说明</span>
          <ChevronDown size={18} aria-hidden="true" />
        </summary>
        <div className="hextech-library-detail-body">
          <dl>
            <div><dt>类型</dt><dd>{KIND_META[kind]?.label} · {KIND_META[kind]?.description}</dd></div>
            <div><dt>发动时机</dt><dd>{skill.timing}</dd></div>
            <div><dt>可用街道</dt><dd>{formatSkillStreets(rules)}</dd></div>
            <div><dt>目标</dt><dd>{formatSkillTarget(rules.target)}</dd></div>
            <div><dt>代价</dt><dd>{formatSkillCost(rules.cost)}</dd></div>
            <div><dt>最大风险</dt><dd>{formatSkillRisk(rules)}</dd></div>
            <div><dt>使用次数</dt><dd>{formatSkillUsage(rules)}</dd></div>
            <div><dt>反制</dt><dd>{formatSkillCounterplay(rules)}</dd></div>
            {probabilityText && <div><dt>概率</dt><dd>{probabilityText}</dd></div>}
          </dl>
          <section aria-label={`${skill.name}使用步骤`}>
            <strong>具体使用步骤</strong>
            <ol>{buildSkillSteps(skill).map((step, index) => <li key={`${skill.id}-step-${index}`}>{step}</li>)}</ol>
          </section>
        </div>
      </details>
    </article>
  );
}

export function HextechSkillLibrary({ open, onClose }) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [rarityFilter, setRarityFilter] = useState("all");
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, [open]);

  const filteredSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return HEXTECH_SKILLS.filter((skill) => {
      const kind = activationKind(skill);
      const legality = skill.cheat || skill.rules.audit?.cheat ? "作弊" : "合法";
      const searchable = `${skill.name} ${skill.category} ${skill.rarity} ${skill.timing} ${skill.summary} ${KIND_META[kind]?.label ?? kind} ${legality}`.toLocaleLowerCase("zh-CN");
      return (!normalizedQuery || searchable.includes(normalizedQuery))
        && (kindFilter === "all" || kind === kindFilter)
        && (rarityFilter === "all" || skill.rarity === rarityFilter);
    });
  }, [kindFilter, query, rarityFilter]);

  if (!open) return null;

  return (
    <div className="hextech-library-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="hextech-library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hextech-library-title"
        aria-describedby="hextech-library-intro"
        ref={dialogRef}
      >
        <header className="hextech-library-header">
          <span className="hextech-library-book" aria-hidden="true"><BookOpen size={25} /></span>
          <div>
            <span className="hextech-library-kicker"><Sparkles size={14} /> 牌局外预习</span>
            <h2 id="hextech-library-title">公共技能图鉴</h2>
            <p id="hextech-library-intro">这里收录当前全部 {HEXTECH_SKILLS.length} 个公共技能。开局前先熟悉时机、代价与反制，三选一时只需判断哪张最适合本手。</p>
          </div>
          <button ref={closeRef} type="button" className="hextech-library-close" onClick={onClose} aria-label="关闭公共技能图鉴"><X size={21} /></button>
        </header>

        <div className="hextech-library-toolbar" aria-label="筛选公共技能">
          <label className="hextech-library-search">
            <Search size={18} aria-hidden="true" />
            <span className="hextech-library-sr-only">搜索公共技能</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、类别、时机或效果" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={16} /></button>}
          </label>
          <div className="hextech-library-filter" role="group" aria-label="按类型筛选">
            <button type="button" className={kindFilter === "all" ? "active" : ""} aria-pressed={kindFilter === "all"} onClick={() => setKindFilter("all")}>全部类型</button>
            {Object.entries(KIND_META).map(([id, meta]) => (
              <button type="button" className={kindFilter === id ? "active" : ""} aria-pressed={kindFilter === id} onClick={() => setKindFilter(id)} key={id}>{meta.label}</button>
            ))}
          </div>
          <label className="hextech-library-rarity">
            <span>稀有度</span>
            <select value={rarityFilter} onChange={(event) => setRarityFilter(event.target.value)}>
              <option value="all">全部稀有度</option>
              {RARITIES.map((rarity) => <option value={rarity} key={rarity}>{rarity}</option>)}
            </select>
          </label>
        </div>

        <div className="hextech-library-results-heading" aria-live="polite">
          <span><ShieldCheck size={17} /> 显示 {filteredSkills.length} / {HEXTECH_SKILLS.length} 个技能</span>
          <small>“作弊”技能会被抓老千审计；“合法”技能不会触发该判定。</small>
        </div>

        <div className="hextech-library-scroll">
          {filteredSkills.length > 0 ? (
            <div className="hextech-library-grid">{filteredSkills.map((skill) => <SkillCard skill={skill} key={skill.id} />)}</div>
          ) : (
            <div className="hextech-library-empty">
              <Search size={23} />
              <strong>没有符合条件的技能</strong>
              <button type="button" onClick={() => { setQuery(""); setKindFilter("all"); setRarityFilter("all"); }}>清除筛选</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
