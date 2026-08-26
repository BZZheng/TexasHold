import React, { useEffect, useId, useMemo, useState } from "react";
import { Check, Eye, Moon, Sparkles, Swords, Target, X } from "lucide-react";
import {
  WENGWENGWEN_CHARACTER,
  WENGWENGWEN_COMMANDS,
  WENGWENGWEN_EVENTS,
  WENGWENGWEN_RULES,
} from "../../shared/hextech-wengwengwen.js";
import { characterImage, characterImageSrcSet } from "./hextech-assets.js";
import "./wengwengwen.css";

const SUITS = Object.freeze({
  c: { mark: "♣", label: "梅花", tone: "dark" },
  d: { mark: "♦", label: "方片", tone: "red" },
  h: { mark: "♥", label: "红桃", tone: "red" },
  s: { mark: "♠", label: "黑桃", tone: "dark" },
});

function commandId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `wengwengwen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function memberName(userId, members) {
  return members.find((member) => String(member.userId) === String(userId))?.username ?? "当前进攻者";
}

function cardParts(cardId) {
  const value = String(cardId ?? "");
  const suit = SUITS[value.at(-1)];
  if (!suit) return null;
  const rank = value.slice(0, -1).replace("T", "10");
  return { rank, ...suit };
}

export function HextechWengwengwenControl({
  state,
  game,
  members = [],
  disabledReason = "",
  onCommand,
}) {
  const titleId = useId();
  const helpId = `${titleId}-help`;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [voiceLine, setVoiceLine] = useState(WENGWENGWEN_CHARACTER.voiceLines.select);
  const resource = Number(state?.resource ?? 0);
  const resourceMaximum = Number(state?.resourceMaximum ?? WENGWENGWEN_RULES.resource.maximum);
  const targetUserId = state?.latestAggressorUserId ?? null;
  const targetName = memberName(targetUserId, members);
  const ownPlayer = game?.players?.find((player) => String(player.userId) === String(state?.userId));
  const ownTurn = ownPlayer?.seat != null && ownPlayer.seat === game?.actingSeat;
  const toCall = ownPlayer ? Math.max(0, Number(game?.currentBet ?? 0) - Number(ownPlayer.bet ?? 0)) : 0;
  const legalStreet = WENGWENGWEN_RULES.active.legalStreets.includes(game?.stage);
  const unavailableReason = disabledReason
    || (!ownTurn ? "等待轮到自己行动" : "")
    || (!legalStreet ? "只能在翻牌圈或转牌圈发动" : "")
    || (!(toCall > 0) ? "当前没有需要回应的主动进攻" : "")
    || (!targetUserId ? "本街尚无符合条件的主动进攻者" : "")
    || (state?.activeUsed ? "本手已经发动过月蚀追猎" : "")
    || (resource < WENGWENGWEN_RULES.active.cost ? "需要 2 点月痕" : "");
  const reveal = state?.reveal ?? null;
  const revealedCard = cardParts(reveal?.cardId);
  const progressRows = useMemo(() => WENGWENGWEN_RULES.growth.counters.map((counter) => ({
    ...counter,
    value: Math.min(counter.target, Number(state?.progress?.[counter.id] ?? 0)),
  })), [state?.progress]);
  const latestEvent = state?.recentEvents?.at?.(-1) ?? null;

  useEffect(() => {
    setConfirming(false);
    setBusy(false);
  }, [game?.handId, state?.activeUsed]);

  useEffect(() => {
    if (latestEvent?.type === WENGWENGWEN_EVENTS.AWAKENED || state?.awakened && !latestEvent) {
      setVoiceLine(WENGWENGWEN_CHARACTER.voiceLines.awaken);
    } else if (latestEvent?.type === WENGWENGWEN_EVENTS.HUNT_ACTIVATED) {
      setVoiceLine(WENGWENGWEN_CHARACTER.voiceLines.activate);
    } else if ([WENGWENGWEN_EVENTS.RESOURCE_GAINED, WENGWENGWEN_EVENTS.FULL_MOON_REFUND].includes(latestEvent?.type)) {
      setVoiceLine(WENGWENGWEN_CHARACTER.voiceLines.progress);
    }
  }, [latestEvent?.eventSeq, latestEvent?.type, state?.awakened]);

  async function activate() {
    if (unavailableReason || busy) return;
    setBusy(true);
    setVoiceLine(WENGWENGWEN_CHARACTER.voiceLines.activate);
    try {
      await onCommand?.(WENGWENGWEN_COMMANDS.ACTIVATE_HUNT, { commandId: commandId() });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`wengwengwen-control ${state?.awakened ? "is-awakened" : ""}`}
      aria-labelledby={titleId}
      data-control-rail="character"
    >
      <header className="wengwengwen-identity">
        <img
          src={characterImage("wengwengwen", state?.awakened)}
          srcSet={characterImageSrcSet("wengwengwen", state?.awakened)}
          sizes="58px"
          width="192"
          height="288"
          alt=""
          decoding="async"
        />
        <span>
          <small>{WENGWENGWEN_CHARACTER.title}</small>
          <strong id={titleId}>{WENGWENGWEN_CHARACTER.name}</strong>
          <em aria-live="polite" aria-atomic="true">{voiceLine}</em>
        </span>
        <button
          type="button"
          className="wengwengwen-help-trigger"
          aria-expanded={helpOpen}
          aria-controls={helpId}
          onClick={() => setHelpOpen((open) => !open)}
        >
          <Eye size={16} /> 说明
        </button>
      </header>

      <div className="wengwengwen-resource" aria-label={`月痕 ${resource}/${resourceMaximum}`}>
        <span>月痕</span>
        <div aria-hidden="true">
          {Array.from({ length: resourceMaximum }, (_, index) => (
            <Moon className={index < resource ? "filled" : ""} size={21} key={index} />
          ))}
        </div>
        <strong>{resource}/{resourceMaximum}</strong>
      </div>

      <div className="wengwengwen-workspace">
        {helpOpen ? (
          <div className="wengwengwen-help" id={helpId}>
            <strong><Target size={15} /> 月蚀追猎</strong>
            <p>面对本街最后一名主动进攻者时，消耗 2 月痕，服务端随机展示其一张底牌。</p>
            <small>伪装技能可能使牌面失真；发动后不可撤销，也不会改变下注金额或牌堆。</small>
          </div>
        ) : reveal && revealedCard ? (
          <div className="wengwengwen-reveal" role="status" aria-live="polite">
            <span className={`wengwengwen-reveal-card ${revealedCard.tone}`} aria-label={`${revealedCard.label}${revealedCard.rank}`}>
              <b>{revealedCard.rank}</b><i aria-hidden="true">{revealedCard.mark}</i>
            </span>
            <span>
              <small>{memberName(reveal.targetUserId, members)}的一张展示底牌</small>
              <strong>只对你可见 · 保留到本街结束</strong>
              <em>伪装技能可能使展示结果失真</em>
            </span>
          </div>
        ) : confirming ? (
          <div className="wengwengwen-confirm" role="alertdialog" aria-label="确认发动月蚀追猎">
            <Target size={24} />
            <span>
              <strong>追猎 {targetName}</strong>
              <small>消耗 2 月痕，随机查看一张展示底牌。发动后不可撤销。</small>
            </span>
          </div>
        ) : (
          <div className="wengwengwen-ready">
            <Swords size={24} />
            <span>
              <strong>{targetUserId ? `目标：${targetName}` : "等待主动进攻者"}</strong>
              <small>{unavailableReason || "当前可发动月蚀追猎"}</small>
            </span>
          </div>
        )}
      </div>

      <div className="wengwengwen-actions" aria-label="人物技能操作">
        {confirming ? (
          <>
            <button type="button" className="primary" disabled={busy} onClick={activate}>
              <Check size={16} /> {busy ? "提交中" : "确认发动"}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              <X size={16} /> 取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={Boolean(unavailableReason)}
              onClick={() => setConfirming(true)}
            >
              <Moon size={16} /> 发动月蚀追猎
            </button>
            <span aria-hidden="true" />
          </>
        )}
      </div>

      <div className="wengwengwen-growth" aria-label="觉醒进度">
        <span><Sparkles size={14} /> {state?.awakened ? "满月双刃已觉醒" : "觉醒进度"}</span>
        {progressRows.map((row) => (
          <small key={row.id}>{row.label} {row.value}/{row.target}</small>
        ))}
      </div>
    </section>
  );
}

export default HextechWengwengwenControl;
