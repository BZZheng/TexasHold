import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  LockKeyhole,
  RefreshCw,
  Sparkles,
  TimerReset,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import {
  HEXTECH_CHARACTERS,
  HEXTECH_MODE,
  HEXTECH_SKILLS,
  ROOM_MODES,
  hextechCharacter,
  hextechSkill,
  hextechTargetForPlayers,
} from "../../shared/hextech.js";
import { HEXTECH_CHARACTER_VOICE_LINES } from "../../shared/hextech-character-voice-lines.js";
import {
  characterImage,
  characterImageSrcSet,
  skillImage,
  skillImageSrcSet,
} from "./hextech-assets.js";

export { characterImage, skillImage } from "./hextech-assets.js";

export function RoomModePicker({ mode, onChange }) {
  return (
    <fieldset className="hextech-mode-picker full-field">
      <legend>房间模式</legend>
      <div className="hextech-mode-options">
        <button
          type="button"
          className={`hextech-mode-option ${mode === ROOM_MODES.CLASSIC ? "selected" : ""}`}
          aria-pressed={mode === ROOM_MODES.CLASSIC}
          onClick={() => onChange(ROOM_MODES.CLASSIC)}
        >
          <span className="hextech-mode-icon classic"><span>♠</span></span>
          <span><strong>经典德州</strong><small>自定义筹码、盲注与人数</small></span>
          {mode === ROOM_MODES.CLASSIC && <Check size={17} />}
        </button>
        <button
          type="button"
          className={`hextech-mode-option chaos ${mode === ROOM_MODES.HEXTECH_CHAOS ? "selected" : ""}`}
          aria-pressed={mode === ROOM_MODES.HEXTECH_CHAOS}
          onClick={() => onChange(ROOM_MODES.HEXTECH_CHAOS)}
        >
          <span className="hextech-mode-icon chaos"><Sparkles size={22} /></span>
          <span><strong>海克斯大乱德</strong><small>人物成长 · 每手技能三选一</small></span>
          {mode === ROOM_MODES.HEXTECH_CHAOS && <Check size={17} />}
        </button>
      </div>
    </fieldset>
  );
}

export function HextechCreateSummary({ playerCount }) {
  const target = hextechTargetForPlayers(playerCount);
  return (
    <section className="hextech-create-summary full-field" aria-label="海克斯玩法摘要">
      <span><Sparkles size={20} /></span>
      <div><strong>{playerCount} 人目标 {target.toLocaleString("zh-CN")}</strong><small>实际目标会按首手开局座位人数锁定</small></div>
      <dl>
        <div><dt>初始 / 补筹</dt><dd>2,000 · 最多 3 次</dd></div>
        <div><dt>盲注</dt><dd>20/40 → 120/240</dd></div>
        <div><dt>时长兜底</dt><dd>15 手 · 约 30 分钟</dd></div>
      </dl>
    </section>
  );
}

export function HextechCharacterSelect({ room, act }) {
  const [previewId, setPreviewId] = useState(room.self.characterId ?? HEXTECH_CHARACTERS[0].id);
  const selectedId = room.self.characterId;
  const preview = hextechCharacter(previewId) ?? HEXTECH_CHARACTERS[0];
  const occupied = useMemo(() => new Map(
    room.members
      .filter((member) => member.characterId && !member.isSelf)
      .map((member) => [member.characterId, member]),
  ), [room.members]);

  useEffect(() => {
    if (selectedId) setPreviewId(selectedId);
  }, [selectedId]);

  function choose(characterId) {
    setPreviewId(characterId);
    if (room.self.ready || occupied.has(characterId)) return;
    act("room:select-character", { characterId });
  }

  return (
    <section className="hextech-character-rail" aria-labelledby="hextech-character-title">
      <header>
        <span className="hextech-kicker"><Sparkles size={15} /> 人物整场唯一</span>
        <div>
          <h2 id="hextech-character-title">先选择你的人物</h2>
          <p>{selectedId ? "人物已锁定，取消准备后可在开局前更换。" : "预览不会占位；点击可用人物后才由服务器锁定。"}</p>
        </div>
        <span className="hextech-target-pill"><Trophy size={15} /> 目标 {room.hextech.targetChips.toLocaleString("zh-CN")}</span>
      </header>

      <div className="hextech-character-gallery" role="listbox" aria-label="海克斯人物">
        {HEXTECH_CHARACTERS.map((character, index) => {
          const owner = occupied.get(character.id);
          const selected = selectedId === character.id;
          return (
            <button
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={`${character.name}，${character.role}${owner ? `，已被 ${owner.username} 占用` : ""}`}
              className={`hextech-character-card ${selected ? "selected" : ""} ${owner ? "occupied" : ""}`}
              disabled={Boolean(owner) || room.self.ready}
              onMouseEnter={() => setPreviewId(character.id)}
              onFocus={() => setPreviewId(character.id)}
              onClick={() => choose(character.id)}
              key={character.id}
            >
              <span className="hextech-character-art"><img src={characterImage(character.id)} srcSet={characterImageSrcSet(character.id)} sizes="78px" width="192" height="288" alt="" decoding="async" fetchPriority={index === 0 ? "high" : "auto"} /></span>
              <span><strong>{character.name}</strong><small>{character.role}</small></span>
              {owner ? <em><LockKeyhole size={11} /> {owner.username}</em> : selected ? <em><Check size={11} /> 已锁定</em> : <em>可选择</em>}
            </button>
          );
        })}
      </div>

      <article className="hextech-character-detail">
        <span className="hextech-character-detail-art"><img src={characterImage(preview.id)} srcSet={characterImageSrcSet(preview.id)} sizes="76px" width="192" height="288" alt={`${preview.name}人物立绘`} decoding="async" fetchPriority="high" /></span>
        <div className="hextech-character-detail-copy">
          <span><b>{preview.name}</b><em>{preview.role}</em><small>资源 · {preview.resource}</small></span>
          <p>{preview.summary}</p>
          <blockquote>“{HEXTECH_CHARACTER_VOICE_LINES[preview.id]?.select}”</blockquote>
        </div>
        <dl>
          <div><dt>被动</dt><dd>{preview.passive}</dd></div>
          <div><dt>主动</dt><dd>{preview.active}</dd></div>
          <div><dt>成长</dt><dd>{preview.growth}</dd></div>
          <div><dt>觉醒</dt><dd>{preview.awaken}</dd></div>
        </dl>
      </article>
    </section>
  );
}

function useDraftSeconds(deadline) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function HextechEquipmentDraft({ room, act }) {
  const offer = room.hextech.draft?.selfOffer;
  const [selectedId, setSelectedId] = useState(offer?.selectedSkillId ?? null);
  const [busy, setBusy] = useState(false);
  const seconds = useDraftSeconds(room.hextech.draft?.deadline ?? Date.now());

  useEffect(() => {
    setSelectedId(offer?.selectedSkillId ?? null);
    setBusy(false);
  }, [offer?.offerId, offer?.selectedSkillId]);

  if (!offer) {
    return (
      <section className="hextech-draft-panel waiting" role="status">
        <Sparkles size={24} /><strong>正在等待参赛玩家装备</strong><small>观战者不会收到其他玩家的三选一内容。</small>
      </section>
    );
  }

  async function refresh() {
    setBusy(true);
    await act("hextech:refresh-offer", { offerId: offer.offerId });
    setBusy(false);
  }

  async function equip() {
    if (!selectedId) return;
    setBusy(true);
    await act("hextech:select-skill", { offerId: offer.offerId, skillId: selectedId });
    setBusy(false);
  }

  const locked = Boolean(offer.selectedSkillId);
  return (
    <section className="hextech-draft-panel" aria-labelledby="hextech-draft-title">
      <header>
        <div><span className="hextech-kicker"><Zap size={14} /> 本手只装备一个</span><h2 id="hextech-draft-title">公共技能三选一</h2></div>
        <span className={`hextech-draft-timer ${seconds <= 3 ? "urgent" : ""}`}><TimerReset size={17} /> {seconds}s</span>
        <span className="hextech-draft-progress"><Users size={15} /> {room.hextech.draft.lockedCount}/{room.hextech.draft.playerCount} 已装备</span>
      </header>

      <div className="hextech-skill-options" role="listbox" aria-label="本手技能选项">
        {offer.skillIds.map((skillId) => {
          const current = hextechSkill(skillId);
          const selected = selectedId === skillId;
          return (
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className={`hextech-skill-card rarity-${current.rarity} ${selected ? "selected" : ""}`}
              disabled={locked || busy}
              onClick={() => setSelectedId(skillId)}
              key={skillId}
            >
              <span className="hextech-skill-art"><img src={skillImage(skillId)} srcSet={skillImageSrcSet(skillId)} sizes="48px" width="128" height="128" alt="" decoding="async" /></span>
              <span className="hextech-skill-tags"><em>{current.rarity}</em><em>{current.category}</em>{current.cheat && <em className="cheat">作弊技能</em>}</span>
              <strong>{current.name}</strong>
              <small>{current.timing}</small>
              <p>{current.summary}</p>
              <b>{selected ? <><Check size={12} /> 已预选</> : "选择"}</b>
            </button>
          );
        })}
      </div>

      <footer>
        <button type="button" className="button secondary" disabled={locked || busy || offer.refreshesRemaining <= 0} onClick={refresh}>
          <RefreshCw size={16} /> 免费刷新 {offer.refreshesRemaining}/1
        </button>
        <span>{locked ? "已提交，等待其他玩家" : seconds === 0 ? "正在等待服务端自动装备" : "预选不会提交，装备后不可更改"}</span>
        <button type="button" className="button primary" disabled={!selectedId || locked || busy} onClick={equip}>
          {locked ? <><Check size={16} /> 已装备</> : busy ? "正在提交…" : "装备本手技能"}
        </button>
      </footer>
    </section>
  );
}

export function HextechMatchStrip({ room }) {
  const character = hextechCharacter(room.self.characterId);
  const characterState = room.hextech?.selfCharacter;
  const equipped = hextechSkill(room.self.equippedSkillId);
  const currentBlind = room.game ? `${room.game.smallBlind}/${room.game.bigBlind}` : "—";
  return (
    <aside className="hextech-match-strip" aria-label="海克斯本场状态">
      <span className="hextech-strip-character">
        {character && <img src={characterImage(character.id, characterState?.awakened)} srcSet={characterImageSrcSet(character.id, characterState?.awakened)} sizes="34px" width="192" height="288" alt="" decoding="async" />}
        <span><small>{characterState?.awakened ? "觉醒人物" : "人物"}</small><strong>{character?.name ?? "观战席"}</strong><em>{characterState ? `${character.rules.resource.label} ${characterState.resource}${characterState.resourceMaximum == null ? "" : `/${characterState.resourceMaximum}`}` : character?.role ?? "全桌视角"}</em></span>
      </span>
      <span className="hextech-strip-skill">
        {equipped && <img src={skillImage(equipped.id)} srcSet={skillImageSrcSet(equipped.id)} sizes="34px" width="128" height="128" alt="" decoding="async" />}
        <span><small>本手装备</small><strong>{equipped?.name ?? "等待装备"}</strong><em>{equipped?.timing ?? "三选一由服务端发放"}</em></span>
      </span>
      <span className="hextech-strip-progress"><small>胜利目标</small><strong>{room.hextech.targetChips.toLocaleString("zh-CN")}</strong><em>当前盲注 {currentBlind}</em></span>
      <span className="hextech-strip-progress"><small>手数上限</small><strong>{room.handNumber}/{room.hextech.maxHands}</strong><em>约 30 分钟</em></span>
    </aside>
  );
}

export function HextechMatchEnd({ room, onLeave }) {
  const matchEnd = room.hextech.matchEnd;
  if (!matchEnd) return null;
  return (
    <section className="hextech-match-end">
      <span className="hextech-match-end-mark"><Trophy size={30} /></span>
      <p className="eyebrow">{matchEnd.reason === "target" ? "动态目标已达成" : matchEnd.reason === "last-player" ? "最后留场胜利" : `${HEXTECH_MODE.maxHands} 手兜底结算`}</p>
      <h2>{matchEnd.standings[0]?.username ?? "领先玩家"} 赢得本场</h2>
      <p>第 {matchEnd.handNumber} 手完整结算后锁定结果；{matchEnd.reason === "hand-cap" ? "兜底名次按净资产计算" : `本房间目标为 ${matchEnd.targetChips.toLocaleString("zh-CN")}`}。</p>
      <div className="hextech-final-standings">
        {matchEnd.standings.map((entry, index) => {
          const character = hextechCharacter(entry.characterId);
          return (
            <article key={entry.userId} className={index === 0 ? "winner" : ""}>
              <b>{index + 1}</b>
              {character && <img src={characterImage(character.id)} srcSet={characterImageSrcSet(character.id)} sizes="42px" width="192" height="288" alt="" loading="lazy" decoding="async" />}
              <span><strong>{entry.username}</strong><small>{character?.name ?? "未选择人物"}</small></span>
              <em>{(matchEnd.reason === "hand-cap" ? entry.netAssets : entry.chips).toLocaleString("zh-CN")}</em>
            </article>
          );
        })}
      </div>
      <button type="button" className="button primary" onClick={onLeave}>确认并返回大厅</button>
    </section>
  );
}

export { HEXTECH_SKILLS };
