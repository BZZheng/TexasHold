import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Award,
  BookOpen,
  Check,
  ChevronDown,
  CircleDollarSign,
  Copy,
  Crown,
  Eye,
  EyeOff,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  Minus,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Spade,
  Sparkles,
  Sun,
  TimerReset,
  Trophy,
  UserRound,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { api, clearLegacyToken, connectSocket, emit } from "./api.js";
import { PlayingCard } from "./cards.jsx";
import {
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_RARITIES,
  AVATAR_TONES,
  DEFAULT_PLAYER_TITLE,
  achievementsForPublicDisplay,
} from "../shared/achievements.js";
import {
  HOLE_CARD_DEAL_TIMING,
  holeCardDealDelayMs,
  holeCardDealDurationMs,
  holeCardDealOrder,
} from "../shared/dealing.js";
import {
  CHIP_UNIT,
  LOW_STACK_REBUY_THRESHOLD,
  chipBreakdown,
} from "../shared/chips.js";
import { buildRaisePresets, normalizeRaiseTarget } from "../shared/betting.js";
import {
  HEXTECH_MODE,
  ROOM_MODES,
  hextechCharacter,
  hextechTargetForPlayers,
} from "../shared/hextech.js";
import {
  HextechCharacterSelect,
  HextechCreateSummary,
  HextechEquipmentDraft,
  HextechMatchEnd,
  HextechMatchStrip,
  RoomModePicker,
  characterImage,
} from "./hextech/HextechUi.jsx";
import { HextechCharacterControl } from "./hextech/HextechCharacterControl.jsx";
import { HextechSkillControl } from "./hextech/HextechSkillControl.jsx";
import { HextechSkillLibrary } from "./hextech/HextechSkillLibrary.jsx";
import {
  actionLogEntryKey,
  actionVoiceAnnouncement,
  browserSpeechAvailable,
  cancelVoiceAnnouncements,
  speakVoiceAnnouncement,
} from "./voice-announcements.js";

const DEFAULT_SETTINGS = {
  maxPlayers: 8,
  initialChips: 2000,
  smallBlind: 5,
  bigBlind: 10,
  allowRebuy: true,
  rebuyAmount: 2000,
  maxRebuys: 3,
  password: "",
};

const DISPLAY_PREFERENCES_KEY = "friends-holdem-display-preferences";
const DEFAULT_DISPLAY_PREFERENCES = Object.freeze({
  theme: "dark",
  fontSize: "standard",
  voiceAnnouncements: true,
});
const FONT_SIZE_META = {
  small: { label: "小", pixels: "12px" },
  standard: { label: "标准", pixels: "14px" },
  large: { label: "大", pixels: "16px" },
};

function normalizeDisplayPreferences(value) {
  return {
    theme: value?.theme === "light" ? "light" : "dark",
    fontSize: Object.hasOwn(FONT_SIZE_META, value?.fontSize) ? value.fontSize : "standard",
    voiceAnnouncements: value?.voiceAnnouncements !== false,
  };
}

function readDisplayPreferences() {
  if (typeof window === "undefined") return DEFAULT_DISPLAY_PREFERENCES;
  try {
    return normalizeDisplayPreferences(JSON.parse(window.localStorage.getItem(DISPLAY_PREFERENCES_KEY)));
  } catch {
    return DEFAULT_DISPLAY_PREFERENCES;
  }
}

function applyDisplayPreferences(preferences) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.fontSize = preferences.fontSize;
}

const initialDisplayPreferences = readDisplayPreferences();
applyDisplayPreferences(initialDisplayPreferences);

function formatChips(value) {
  return Number(value ?? 0).toLocaleString("zh-CN");
}

function formatSignedChips(value) {
  const amount = Number(value ?? 0);
  if (amount > 0) return `+${formatChips(amount)}`;
  if (amount < 0) return `−${formatChips(Math.abs(amount))}`;
  return "0";
}

function stableSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function potChipLayout(seed, amount, index) {
  let state = stableSeed(`${seed}:${amount}:${index}`) || 1;
  const random = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const clusters = [
    { x: -34, y: -3 },
    { x: -5, y: 10 },
    { x: 28, y: -6 },
    { x: 42, y: 14 },
  ];
  const cluster = clusters[Math.floor(random() * clusters.length)];
  return {
    "--chip-x": `${Math.round(cluster.x + (random() - 0.5) * 20)}px`,
    "--chip-y": `${Math.round(cluster.y + (random() - 0.5) * 15)}px`,
    "--chip-rotate": `${Math.round((random() - 0.5) * 38)}deg`,
    "--chip-layer": Math.round(3 + random() * 12),
  };
}

function initials(name) {
  return String(name || "玩家").slice(0, 2);
}

function displayName(user) {
  return user?.displayName || user?.username || "玩家";
}

function PlayerAvatar({ user, name, tone, className = "", children }) {
  const resolvedName = name || displayName(user);
  const resolvedTone = tone || user?.avatarTone || "gold";
  return (
    <span className={`avatar avatar-tone-${resolvedTone} ${className}`.trim()} aria-hidden="true">
      {children || initials(resolvedName)}
    </span>
  );
}

function AchievementBadges({ ids = [], title, excludeTitle, limit = 3 }) {
  const normalizedTitle = String(title ?? "").trim();
  const badges = achievementsForPublicDisplay(ids, [normalizedTitle, excludeTitle]);
  const uniqueBadges = badges.filter((achievement, index, entries) => (
    achievement.title !== normalizedTitle
    && entries.findIndex((entry) => entry.title === achievement.title) === index
  ));
  if (!normalizedTitle && uniqueBadges.length === 0) return null;
  return (
    <span className="identity-badges">
      {normalizedTitle && <em className="identity-title">{normalizedTitle}</em>}
      {uniqueBadges.slice(0, limit).map((achievement) => <em key={achievement.id}>{achievement.title}</em>)}
      {uniqueBadges.length > limit && <em>+{uniqueBadges.length - limit}</em>}
    </span>
  );
}

function ErrorNotice({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="toast" role="alert">
      <span>{message}</span>
      <button className="icon-button" onClick={onClose} aria-label="关闭提示"><X size={18} /></button>
    </div>
  );
}

function PreferencesButton({ onClick, className = "" }) {
  return (
    <button className={`icon-button preferences-button ${className}`.trim()} onClick={onClick} aria-label="界面设置" title="界面设置">
      <Settings size={19} />
    </button>
  );
}

function VoiceAnnouncementsButton({ enabled, onToggle }) {
  const available = browserSpeechAvailable();
  const Icon = enabled ? Volume2 : VolumeX;
  const label = !available ? "当前浏览器不支持语音播报" : enabled ? "关闭语音播报" : "开启语音播报";
  return (
    <button
      className={`icon-button voice-announcements-button ${enabled ? "is-on" : "is-off"}`}
      onClick={onToggle}
      disabled={!available}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
    >
      <Icon size={19} />
    </button>
  );
}

function InterfaceSettings({ open, preferences, onChange, onClose, onToggleVoiceAnnouncements }) {
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;
  const fontMeta = FONT_SIZE_META[preferences.fontSize];
  const voiceAvailable = browserSpeechAvailable();
  return (
    <div className="preferences-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="preferences-drawer" role="dialog" aria-modal="true" aria-labelledby="preferences-title">
        <span className="preferences-handle" aria-hidden="true" />
        <header className="preferences-heading">
          <div>
            <h2 id="preferences-title">界面设置</h2>
            <small>显示与声音</small>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭界面设置"><X size={20} /></button>
        </header>
        <p className="preferences-intro">选择适合当前光线和观看距离的显示方式，牌局会继续进行。</p>

        <section className="preference-group" aria-labelledby="theme-setting-label">
          <div className="preference-group-heading">
            <strong id="theme-setting-label">主题</strong>
            <span>{preferences.theme === "dark" ? "深色" : "浅色"}</span>
          </div>
          <div className="theme-options">
            <button className="theme-option" aria-pressed={preferences.theme === "dark"} onClick={() => onChange({ theme: "dark" })}>
              <span className="theme-swatch dark" aria-hidden="true"><i /><i /></span>
              <span><Moon size={15} />深色</span>
            </button>
            <button className="theme-option" aria-pressed={preferences.theme === "light"} onClick={() => onChange({ theme: "light" })}>
              <span className="theme-swatch light" aria-hidden="true"><i /><i /></span>
              <span><Sun size={15} />浅色</span>
            </button>
          </div>
        </section>

        <section className="preference-group" aria-labelledby="font-setting-label">
          <div className="preference-group-heading">
            <strong id="font-setting-label">字体大小</strong>
            <span>{fontMeta.label} · {fontMeta.pixels}</span>
          </div>
          <div className="font-options">
            {Object.entries(FONT_SIZE_META).map(([value, meta]) => (
              <button key={value} className="font-option" aria-pressed={preferences.fontSize === value} onClick={() => onChange({ fontSize: value })}>
                <b>{meta.label}</b><small>{meta.pixels}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="preference-group" aria-labelledby="voice-setting-label">
          <div className="preference-group-heading">
            <strong id="voice-setting-label">语音播报</strong>
            <span>{voiceAvailable ? (preferences.voiceAnnouncements ? "已开启" : "已静音") : "浏览器不支持"}</span>
          </div>
          <button
            type="button"
            className="voice-preference-toggle"
            role="switch"
            aria-checked={voiceAvailable && preferences.voiceAnnouncements}
            disabled={!voiceAvailable}
            onClick={onToggleVoiceAnnouncements}
          >
            <span className="voice-preference-icon" aria-hidden="true">
              {preferences.voiceAnnouncements ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </span>
            <span>
              <strong>播报普通牌局行动线</strong>
              <small>{voiceAvailable ? "包括盲注、过牌、跟注、加注/全押金额和弃牌" : "当前浏览器没有提供系统语音合成功能"}</small>
            </span>
            <i aria-hidden="true"><b /></i>
          </button>
        </section>

        <section className="preference-group preferences-preview" aria-labelledby="preview-setting-label">
          <div className="preference-group-heading">
            <strong id="preview-setting-label">实时预览</strong>
            <span>随选择更新</span>
          </div>
          <div className="preference-live-sample">
            <div><span>轮到你行动</span><b>26 秒</b></div>
            <span className="preference-mini-table"><small>底池 1,240</small></span>
          </div>
          <p className="preference-device-note"><Monitor size={16} /><span>设置只保存在当前设备，不会改变其他玩家看到的界面。</span></p>
        </section>

        <footer className="preferences-actions">
          <button className="button secondary" onClick={() => onChange(DEFAULT_DISPLAY_PREFERENCES)}><RotateCcw size={17} />恢复默认</button>
          <button className="button primary" onClick={onClose}>完成</button>
        </footer>
      </aside>
    </div>
  );
}

function PlayerProfilePanel({ open, user, onClose, onSaved, showError }) {
  const [profile, setProfile] = useState(null);
  const [draft, setDraft] = useState(null);
  const [category, setCategory] = useState("全部");
  const [rarityFilter, setRarityFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !user) return undefined;
    let active = true;
    setLoading(true);
    api("/api/profile")
      .then(({ profile: nextProfile }) => {
        if (!active) return;
        setProfile(nextProfile);
        setDraft({
          displayName: nextProfile.user.displayName,
          avatarTone: nextProfile.user.avatarTone,
          title: nextProfile.user.title,
          displayedAchievements: [...nextProfile.user.displayedAchievements],
        });
      })
      .catch((error) => showError(error.message))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, showError, user]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;
  const stats = profile?.stats || {};
  const achievements = profile?.achievements || [];
  const unlocked = achievements.filter((achievement) => achievement.unlocked);
  const visibleAchievements = achievements.filter((achievement) => (
    (category === "全部" || achievement.category === category)
    && (rarityFilter === "all" || achievement.rarity === rarityFilter)
  ));
  const legendaryCount = achievements.filter((achievement) => achievement.rarity === "legendary").length;
  const epicCount = achievements.filter((achievement) => achievement.rarity === "epic").length;
  const previewUser = { ...user, ...(profile?.user || {}), ...(draft || {}) };
  const publicPreviewAchievements = achievementsForPublicDisplay(
    draft?.displayedAchievements,
    [draft?.title],
  );

  function toggleAchievement(id) {
    setDraft((current) => {
      const achievement = achievements.find((entry) => entry.id === id);
      if (!achievement || achievement.title === current.title) return current;
      const next = new Set(current.displayedAchievements);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...current, displayedAchievements: [...next] };
    });
  }

  function selectTitle(title) {
    setDraft((current) => ({
      ...current,
      title,
      displayedAchievements: achievementsForPublicDisplay(current.displayedAchievements, [title])
        .map((achievement) => achievement.id),
    }));
  }

  async function saveProfile() {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api("/api/profile", { method: "PATCH", body: JSON.stringify(draft) });
      setProfile(result.profile);
      setDraft({
        displayName: result.user.displayName,
        avatarTone: result.user.avatarTone,
        title: result.user.title,
        displayedAchievements: [...result.user.displayedAchievements],
      });
      onSaved(result.user);
      onClose();
    } catch (error) {
      showError(error.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="profile-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <header className="profile-dialog-header">
          <div>
            <p className="eyebrow">玩家身份</p>
            <h2 id="profile-title">资料与称号成就</h2>
            <p>头像、昵称与公开成就会同步显示在牌桌和两种积分榜中。</p>
          </div>
          <div className="profile-header-actions">
            <button className="button primary" disabled={loading || saving || !draft} onClick={saveProfile}>{saving ? "正在保存…" : "保存资料"}</button>
            <button className="icon-button" onClick={onClose} aria-label="关闭个人资料"><X size={20} /></button>
          </div>
        </header>

        {loading || !draft ? (
          <div className="profile-loading"><Spade size={30} /><span>正在读取玩家资料…</span></div>
        ) : (
          <div className="profile-layout">
            <aside className="profile-summary-card">
              <PlayerAvatar user={previewUser} className="profile-big-avatar" />
              <h3>{displayName(previewUser)}</h3>
              <span className="profile-title-pill"><Award size={13} />{draft.title}</span>
              <div className="profile-stat-row">
                <span><strong>{formatChips(stats.hands)}</strong><small>完成牌局</small></span>
                <span><strong className={stats.netPoints < 0 ? "negative" : ""}>{stats.netPoints > 0 ? "+" : ""}{formatChips(stats.netPoints)}</strong><small>历史积分</small></span>
                <span><strong>{profile.unlockedCount}</strong><small>已获成就</small></span>
              </div>
              <div className="profile-showcase">
                <small>积分榜公开展示</small>
                <AchievementBadges ids={draft.displayedAchievements} excludeTitle={draft.title} limit={60} />
                {publicPreviewAchievements.length === 0 && (
                  <p>{draft.displayedAchievements.length === 0 ? "尚未选择公开成就" : "当前称号已单独展示，不再重复显示"}</p>
                )}
              </div>
            </aside>

            <div className="profile-workbench">
              <section className="profile-editor" aria-labelledby="profile-editor-title">
                <div className="profile-section-heading"><div><p className="eyebrow">身份设置</p><h3 id="profile-editor-title">资料编辑</h3></div><small>登录用户名 {user.username} 不会改变</small></div>
                <div className="profile-form-row">
                  <span>头像色</span>
                  <div className="profile-avatar-options">
                    {AVATAR_TONES.map((tone) => (
                      <button
                        key={tone.id}
                        className={`avatar-tone-${tone.id} ${draft.avatarTone === tone.id ? "active" : ""}`}
                        onClick={() => setDraft((current) => ({ ...current, avatarTone: tone.id }))}
                        aria-label={`${tone.label}头像`}
                        aria-pressed={draft.avatarTone === tone.id}
                      />
                    ))}
                  </div>
                </div>
                <label className="profile-form-row">
                  <span>昵称</span>
                  <input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} maxLength={16} />
                </label>
                <div className="profile-form-row profile-title-row">
                  <span>当前称号</span>
                  <div className="profile-title-options">
                    {[DEFAULT_PLAYER_TITLE, ...unlocked.map((achievement) => achievement.title)].map((title) => (
                      <button key={title} className={draft.title === title ? "active" : ""} onClick={() => selectTitle(title)}>{title}</button>
                    ))}
                  </div>
                </div>
                <div className="profile-display-setting">
                  <div className="profile-display-heading">
                    <strong>公开展示到积分榜的成就</strong>
                    <span>额外展示 {publicPreviewAchievements.length} 项</span>
                  </div>
                  <p>选择已获得的成就；与当前称号相同的徽章只会展示一次。</p>
                  <div className="profile-achievement-options" role="group" aria-label="公开成就">
                    {unlocked.length === 0 ? <small>完成首局后即可解锁第一个成就。</small> : unlocked.map((achievement) => {
                      const selected = publicPreviewAchievements.some((entry) => entry.id === achievement.id);
                      const currentTitle = achievement.title === draft.title;
                      const rarity = ACHIEVEMENT_RARITIES[achievement.rarity] || ACHIEVEMENT_RARITIES.common;
                      return (
                        <button
                          type="button"
                          key={achievement.id}
                          className={`${selected ? "selected" : ""} ${currentTitle ? "current-title" : ""} rarity-${achievement.rarity}`.trim()}
                          aria-pressed={selected || currentTitle}
                          disabled={currentTitle}
                          onClick={() => toggleAchievement(achievement.id)}
                        >
                          <span className="profile-achievement-seal" aria-hidden="true">{achievement.icon}</span>
                          <span className="profile-achievement-copy">
                            <strong>{achievement.title}<em>{rarity.label}</em></strong>
                            <small>{currentTitle ? "已作为当前称号展示" : selected ? "已加入两种积分榜" : "点击加入积分榜展示"}</small>
                          </span>
                          <span className="profile-achievement-state" aria-hidden="true">
                            {currentTitle ? <><Award size={13} />称号</> : selected ? <><Check size={14} />已展示</> : "未展示"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              <section className="achievement-catalog" aria-labelledby="achievement-catalog-title">
                <div className="profile-section-heading catalog-heading">
                  <div><p className="eyebrow">{ACHIEVEMENT_CATALOG.length} 个称号</p><h3 id="achievement-catalog-title">成就图鉴</h3></div>
                  <small>{legendaryCount} 个传说 · {epicCount} 个史诗，倒霉蛋类不影响积分</small>
                </div>
                <div className="achievement-filter-row">
                  <div className="achievement-filters" role="tablist" aria-label="成就分类">
                    {ACHIEVEMENT_CATEGORIES.map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}
                  </div>
                  <label className="achievement-rarity-filter">
                    <span>稀有度</span>
                    <select value={rarityFilter} onChange={(event) => setRarityFilter(event.target.value)} aria-label="成就稀有度">
                      <option value="all">全部</option>
                      {Object.values(ACHIEVEMENT_RARITIES).map((rarity) => <option value={rarity.id} key={rarity.id}>{rarity.label}</option>)}
                    </select>
                  </label>
                </div>
                <div className="achievement-grid">
                  {visibleAchievements.map((achievement) => (
                    <article className={`achievement-card rarity-${achievement.rarity} ${achievement.unlocked ? "unlocked" : "locked"} ${achievement.category === "倒霉蛋" ? "bad-luck" : ""}`} key={achievement.id}>
                      <span className="achievement-icon">{achievement.icon}</span>
                      <span className="achievement-rarity">{(ACHIEVEMENT_RARITIES[achievement.rarity] || ACHIEVEMENT_RARITIES.common).label}</span>
                      <strong>{achievement.title}</strong>
                      <p>{achievement.description}</p>
                      <div className="achievement-progress"><i style={{ width: `${achievement.progress}%` }} /></div>
                      <small>{achievement.unlocked ? "已解锁" : achievement.metric ? `进度 ${achievement.progress}%` : "等待对应牌局事件"}</small>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AuthScreen({ onAuthenticated, onOpenPreferences }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [helper, setHelper] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const result = await api(mode === "login" ? "/api/login" : "/api/register", {
        method: "POST",
        body: JSON.stringify({ username, password, remember }),
      });
      clearLegacyToken();
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <PreferencesButton onClick={onOpenPreferences} className="auth-preferences-button" />
      <section className="auth-story" aria-label="产品介绍">
        <div className="brand-lockup">
          <span className="brand-mark"><Spade size={26} strokeWidth={1.8} /></span>
          <span className="brand-name"><strong>德州扑克</strong><small>好友牌局</small></span>
        </div>
        <div className="auth-copy">
          <p className="eyebrow">2–8 位好友 · 私人牌桌</p>
          <h1>今晚，开一桌。</h1>
          <p>创建房间，分享四位房间码。手机和电脑都能加入，筹码仅用于好友娱乐。</p>
        </div>
        <div className="auth-table-mark" aria-hidden="true"><span>♠</span><span>♥</span><span>♦</span><span>♣</span></div>
        <div className="auth-rule-row">
          <span><ShieldCheck size={18} /> 服务端发牌</span>
          <span><EyeOff size={18} /> 底牌隔离</span>
          <span><Users size={18} /> 最多 8 人</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-panel-inner">
          <p className="panel-index">{mode === "login" ? "登录" : "注册账号"}</p>
          <h2>{mode === "login" ? "回到牌桌" : "创建你的账号"}</h2>
          <form onSubmit={submit} className="form-stack">
            <label>
              <span>用户名</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                placeholder="2–16 个字符"
                required
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder="至少 6 位"
                required
              />
            </label>
            {mode === "register" && (
              <label>
                <span>确认密码</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder="再次输入密码"
                  required
                />
              </label>
            )}
            {mode === "login" && (
              <div className="auth-form-options">
                <label className="remember-field">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                  <span>记住我</span>
                </label>
                <button type="button" className="text-button" onClick={() => setHelper("当前私人版本未配置邮箱找回，请联系房主重置账号密码。")}>忘记密码？</button>
              </div>
            )}
            <div className="form-message-slot" aria-live="polite">
              {helper && <p className="form-helper">{helper}</p>}
              {error && <p className="form-error">{error}</p>}
            </div>
            <button className="button primary wide" disabled={busy}>
              {busy ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}
            </button>
          </form>
          <button
            className="text-button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
              setHelper("");
            }}
          >
            {mode === "login" ? "没有账号？注册账号" : "已有账号？返回登录"}
          </button>
        </div>
      </section>
    </main>
  );
}

function CreateRoomModal({ onClose, onCreate, onOpenSkillLibrary, embedded = false }) {
  const [name, setName] = useState("好友牌局");
  const [roomMode, setRoomMode] = useState(ROOM_MODES.CLASSIC);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);

  function field(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function changeMode(nextMode) {
    setRoomMode(nextMode);
    setSettings((current) => nextMode === ROOM_MODES.HEXTECH_CHAOS ? {
      ...current,
      maxPlayers: Math.min(HEXTECH_MODE.maxPlayers, current.maxPlayers || 6),
      initialChips: HEXTECH_MODE.initialChips,
      smallBlind: 20,
      bigBlind: 40,
      allowRebuy: true,
      rebuyAmount: HEXTECH_MODE.rebuyAmount,
      maxRebuys: HEXTECH_MODE.maxRebuys,
    } : {
      ...DEFAULT_SETTINGS,
      maxPlayers: Math.min(8, current.maxPlayers || DEFAULT_SETTINGS.maxPlayers),
      password: current.password,
    });
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate({
        name,
        mode: roomMode,
        settings: roomMode === ROOM_MODES.HEXTECH_CHAOS
          ? { maxPlayers: settings.maxPlayers, password: settings.password }
          : settings,
      });
    } finally {
      setBusy(false);
    }
  }

  const content = (
      <section className={`modal create-room-modal ${embedded ? "embedded" : ""}`} role="dialog" aria-modal={!embedded} aria-labelledby="create-room-title">
        <header className="modal-header">
          <div>
            <p className="eyebrow">房间设置</p>
            <h2 id="create-room-title">创建房间</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
        </header>
        <form onSubmit={submit} className="room-settings-grid">
          <label className="full-field">
            <span>房间名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
          </label>
          <RoomModePicker mode={roomMode} onChange={changeMode} />
          <label>
            <span>玩家人数</span>
            <select value={settings.maxPlayers} onChange={(event) => field("maxPlayers", Number(event.target.value))}>
              {(roomMode === ROOM_MODES.HEXTECH_CHAOS
                ? Array.from(
                  { length: HEXTECH_MODE.maxPlayers - HEXTECH_MODE.minPlayers + 1 },
                  (_, index) => HEXTECH_MODE.minPlayers + index,
                )
                : [2, 3, 4, 5, 6, 7, 8]
              ).map((number) => <option key={number} value={number}>{number} 人</option>)}
            </select>
          </label>
          {roomMode === ROOM_MODES.CLASSIC ? (
            <>
              <label>
                <span>初始筹码</span>
                <input type="number" min="200" step={CHIP_UNIT} value={settings.initialChips} onChange={(event) => field("initialChips", Number(event.target.value))} />
              </label>
              <label>
                <span>小盲</span>
                <input type="number" min={CHIP_UNIT} step={CHIP_UNIT} value={settings.smallBlind} onChange={(event) => field("smallBlind", Number(event.target.value))} />
              </label>
              <label>
                <span>大盲</span>
                <input type="number" min={CHIP_UNIT * 2} step={CHIP_UNIT} value={settings.bigBlind} onChange={(event) => field("bigBlind", Number(event.target.value))} />
              </label>
              <label className="toggle-field full-field">
                <span><strong>允许补充筹码</strong><small>玩家筹码较低时可选择，下一局生效</small></span>
                <input type="checkbox" checked={settings.allowRebuy} onChange={(event) => field("allowRebuy", event.target.checked)} />
              </label>
              {settings.allowRebuy && (
                <>
                  <label><span>每次补充</span><input type="number" min="200" step={CHIP_UNIT} value={settings.rebuyAmount} onChange={(event) => field("rebuyAmount", Number(event.target.value))} /></label>
                  <label><span>最多补充</span><select value={settings.maxRebuys} onChange={(event) => field("maxRebuys", Number(event.target.value))}>{[1, 2, 3, 4, 5].map((number) => <option key={number} value={number}>{number} 次</option>)}</select></label>
                </>
              )}
            </>
          ) : (
            <>
              <HextechCreateSummary playerCount={settings.maxPlayers} />
              <aside className="hextech-library-create-entry" aria-label="海克斯公共技能预习">
                <span><strong>开局前先看公共技能</strong><small>完整预习 30 个技能的时机、代价、风险与反制，创建设置会原样保留。</small></span>
                <button type="button" onClick={onOpenSkillLibrary}><BookOpen size={17} /> 打开技能图鉴</button>
              </aside>
            </>
          )}
          <label className="full-field">
            <span>房间密码（可选）</span>
            <input type="password" value={settings.password} onChange={(event) => field("password", event.target.value)} maxLength={20} />
          </label>
          {roomMode === ROOM_MODES.CLASSIC && <div className="settings-summary full-field">
            <CircleDollarSign size={20} />
            <span>买入 {formatChips(settings.initialChips)} · 在桌上限 {formatChips(settings.initialChips * 2)} · 盲注 {settings.smallBlind}/{settings.bigBlind}</span>
          </div>}
          <button className="button primary wide full-field" disabled={busy}>{busy ? "正在创建…" : "创建房间"}</button>
        </form>
      </section>
  );
  return embedded ? <section className="create-room-page">{content}</section> : <div className="modal-backdrop" role="presentation">{content}</div>;
}

function Lobby({ user, socket, onLogout, onRoom, showError, onOpenPreferences, onOpenProfile, onOpenSkillLibrary }) {
  const [rooms, setRooms] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [historyLeaderboard, setHistoryLeaderboard] = useState([]);
  const [leaderboardMode, setLeaderboardMode] = useState("realtime");
  const [showCreate, setShowCreate] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [joinMode, setJoinMode] = useState("player");
  const [joining, setJoining] = useState(false);
  const joinCodeRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const result = await emit(socket, "lobby:list");
      setRooms(result.rooms);
      setLeaderboard(result.leaderboard);
    } catch (error) {
      showError(error.message);
    }
  }, [socket, showError]);

  useEffect(() => {
    refresh();
    function updateRooms(nextRooms) { setRooms(nextRooms); }
    function updateLeaderboard(nextLeaderboard) { setLeaderboard(nextLeaderboard); }
    socket.on("lobby:update", updateRooms);
    socket.on("leaderboard:update", updateLeaderboard);
    return () => {
      socket.off("lobby:update", updateRooms);
      socket.off("leaderboard:update", updateLeaderboard);
    };
  }, [refresh, socket]);

  const refreshHistoryLeaderboard = useCallback(async () => {
    try {
      const result = await api("/api/leaderboards/history");
      setHistoryLeaderboard(result.leaderboard);
    } catch (error) {
      showError(error.message);
    }
  }, [showError]);

  useEffect(() => {
    refreshHistoryLeaderboard();
  }, [refreshHistoryLeaderboard, user.displayName, user.title, user.displayedAchievements]);

  async function createRoom(payload) {
    try {
      const result = await emit(socket, "room:create", payload);
      setShowCreate(false);
      onRoom(result.room, "player");
    } catch (error) {
      showError(error.message);
    }
  }

  async function join(event, explicitCode = null, explicitMode = null) {
    event?.preventDefault();
    const code = explicitCode || joinCode;
    const requestedMode = explicitMode || joinMode;
    if (!code) return;
    setJoining(true);
    try {
      const result = await emit(socket, "room:join", { code: code.trim().toUpperCase(), password: joinPassword.trim(), mode: requestedMode });
      onRoom(result.room, requestedMode === "player" ? "seat-select" : "spectator");
    } catch (error) {
      showError(error.message);
    } finally {
      setJoining(false);
    }
  }

  const lobbyHeader = (
      <header className="topbar">
        <div className="brand-lockup compact"><span className="brand-mark"><Spade size={22} /></span><span className="brand-name"><strong>德州扑克</strong><small>好友牌局</small></span></div>
        <div className="user-menu">
          <button className="profile-entry" onClick={onOpenProfile} aria-label="打开个人资料">
            <PlayerAvatar user={user} />
            <span><strong>{displayName(user)}</strong><small>{user.title || DEFAULT_PLAYER_TITLE} · 个人资料</small></span>
          </button>
          <PreferencesButton onClick={onOpenPreferences} />
          <button className="icon-button" onClick={onLogout} aria-label="退出登录"><LogOut size={19} /></button>
        </div>
      </header>
  );

  if (showCreate) {
    return (
      <>
        <main className="app-shell lobby-shell create-route">
          {lobbyHeader}
          <CreateRoomModal embedded onClose={() => setShowCreate(false)} onCreate={createRoom} onOpenSkillLibrary={onOpenSkillLibrary} />
        </main>
      </>
    );
  }

  return (
    <main className="app-shell lobby-shell">
      {lobbyHeader}

      <section className="lobby-hero">
        <div>
          <p className="eyebrow">游戏大厅</p>
          <h1>选择你的牌桌</h1>
          <p>创建私人房间，或者输入好友发来的四位房间码。</p>
        </div>
        <div className="hero-actions">
          <button className="button primary hero-action" onClick={() => setShowCreate(true)}><Plus size={20} /> 创建房间</button>
          <button className="button secondary hero-action" onClick={() => joinCodeRef.current?.focus()}><LockKeyhole size={18} /> 加入房间</button>
          <button className="button secondary hero-action hextech-library-entry" onClick={onOpenSkillLibrary}><BookOpen size={18} /> 海克斯公共技能图鉴 · 30</button>
        </div>
      </section>

      <section className="lobby-grid">
        <article className="panel join-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">房间码</p><h2>加入房间</h2></div>
            <LockKeyhole size={22} />
          </div>
          <form onSubmit={join} className="join-form">
            <input ref={joinCodeRef} className="room-code-input" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} maxLength={4} placeholder="例如 8F2K" />
            <input value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} type="password" placeholder="房间密码（如有）" />
            <div className="segmented" role="group" aria-label="加入方式">
              <button type="button" className={joinMode === "player" ? "active" : ""} onClick={() => setJoinMode("player")}><Users size={17} /> 入座</button>
              <button type="button" className={joinMode === "spectator" ? "active" : ""} onClick={() => setJoinMode("spectator")}><Eye size={17} /> 观战</button>
            </div>
            <button className="button secondary wide" disabled={joining || joinCode.length !== 4}>{joining ? "正在加入…" : "加入房间"}</button>
          </form>
        </article>

        <article className="panel room-list-panel">
          <div className="panel-heading"><div><p className="eyebrow">当前可见</p><h2>好友房间</h2></div><Users size={22} /></div>
          <div className="room-list">
            {rooms.length === 0 ? (
              <div className="empty-state"><p>还没有正在等待的房间。</p><button className="text-button" onClick={() => setShowCreate(true)}>创建第一间房</button></div>
            ) : rooms.map((room) => (
              <div key={room.code} className="room-row">
                <span><strong>{room.name}{room.mode === ROOM_MODES.HEXTECH_CHAOS && <em className="room-mode-badge"><Sparkles size={10} /> 海克斯</em>}</strong><small>{room.code} · {room.smallBlind}/{room.bigBlind}{room.targetChips ? ` · 技能三选一 · 目标 ${formatChips(room.targetChips)}` : ""}</small></span>
                <span><strong>{room.playerCount}/{room.maxPlayers}</strong><small>{room.status}</small></span>
                <button className="room-watch" onClick={() => { setJoinCode(room.code); setJoinMode("spectator"); join(null, room.code, "spectator"); }}><Eye size={15} /> 观战</button>
              </div>
            ))}
          </div>
        </article>

        <article className="panel leaderboard-panel">
          <div className="panel-heading leaderboard-heading">
            <div><p className="eyebrow">积分榜单</p><h2>{leaderboardMode === "realtime" ? "实时积分榜" : "历史积分榜"}</h2></div>
            <div className="leaderboard-tabs" role="tablist" aria-label="积分榜类型">
              <button className={leaderboardMode === "realtime" ? "active" : ""} onClick={() => setLeaderboardMode("realtime")}><span className="live-dot" />实时</button>
              <button className={leaderboardMode === "history" ? "active" : ""} onClick={() => { setLeaderboardMode("history"); refreshHistoryLeaderboard(); }}>历史</button>
            </div>
          </div>
          {leaderboardMode === "history" && <p className="leaderboard-rule-note">仅统计好友正式牌局；包含测试玩家的练习局不计积分、胜局与成就。</p>}
          <div className="leaderboard-list" aria-live="polite">
            {(leaderboardMode === "realtime" ? leaderboard : historyLeaderboard).length === 0 ? <div className="empty-state"><Trophy size={24} /><p>{leaderboardMode === "realtime" ? "暂无在线玩家。" : "完成首场好友正式牌局后会进入历史积分榜。"}</p></div> : (leaderboardMode === "realtime" ? leaderboard : historyLeaderboard).map((entry) => (
              <div className={`leaderboard-row rank-${Math.min(entry.rank, 4)} ${entry.userId === user.id ? "self" : ""}`} key={entry.userId}>
                <span className="leaderboard-rank" aria-label={`第 ${entry.rank} 名`}>{entry.rank}</span>
                <PlayerAvatar name={entry.username} tone={entry.avatarTone} className="leaderboard-avatar" />
                <span className="leaderboard-player">
                  <strong>{entry.username}{entry.userId === user.id && <small>你</small>}</strong>
                  <small>{leaderboardMode === "history" ? `${entry.hands} 局 · ${entry.wins} 胜` : entry.roomCode ? `${entry.status} · ${entry.roomCode}` : entry.status}</small>
                  <AchievementBadges ids={entry.displayedAchievements} title={entry.title} />
                </span>
                <span className="leaderboard-score"><strong>{entry.score > 0 && leaderboardMode === "history" ? "+" : ""}{formatChips(entry.score)}</strong><small>{leaderboardMode === "history" ? "累计积分" : "当前筹码"}</small></span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

function Chip({ amount }) {
  if (!amount) return null;
  const breakdown = chipBreakdown(amount);
  const chips = breakdown.remainder === 0 ? breakdown.chips : [];
  return (
    <span className="chip-bet" aria-label={`本轮下注 ${formatChips(amount)}`}>
      <span className="bet-chip-scatter">
        {chips.slice(0, 5).map(({ value, count }, index) => (
          <i className={`bet-real-chip denom-${value}`} style={{ "--bet-chip-index": index }} key={`${value}-${index}`}>
            <small>{value}</small>{count > 1 && <b>×{count}</b>}
          </i>
        ))}
      </span>
      <strong>{formatChips(amount)}</strong>
    </span>
  );
}

function PotChips({ amount, seed, collecting = false, winnerSeat = null }) {
  const previousAmount = useRef(Number(amount) || 0);
  const [impacting, setImpacting] = useState(false);
  useEffect(() => {
    const nextAmount = Number(amount) || 0;
    const increased = nextAmount > previousAmount.current;
    previousAmount.current = nextAmount;
    if (!increased) return undefined;
    setImpacting(true);
    const timer = window.setTimeout(() => setImpacting(false), 620);
    return () => window.clearTimeout(timer);
  }, [amount]);
  const breakdown = chipBreakdown(amount);
  const stacks = breakdown.remainder === 0 ? breakdown.chips : [];
  const formula = stacks.map(({ value, count }) => count > 1 ? `${value}×${count}` : String(value)).join(" + ");
  return (
    <div className={`pot-chips ${collecting ? "collecting" : ""} ${impacting ? "chip-impact" : ""}`} data-winner-seat={winnerSeat ?? ""} aria-label={`公共池筹码 ${formatChips(amount)}`}>
      <div className="pot-chip-scatter">
        {stacks.map(({ value, count }, index) => (
          <span className={`real-chip denom-${value} stack-depth-${Math.min(4, count)}`} style={{ "--chip-index": index, ...potChipLayout(seed, amount, index) }} key={value}>
            <small>{value}</small>{count > 1 && <b>×{count}</b>}
          </span>
        ))}
      </div>
      {formula && <small className="pot-chip-formula">{formula} = {formatChips(amount)}</small>}
    </div>
  );
}

function PlayerSeat({ member, gamePlayer, characterState, index, game, onRemoveBot, onSelectSeat, onWatchPlayer, selected, dealingHoleCards, dealOrderIndex, dealPlayerCount, spectatorFocused = false, spectatorMystery = false, spectatorPrivate = false }) {
  const active = game?.actingSeat === index;
  const stack = game?.stage === "finished"
    ? ((member?.stack || 0) + (member?.pendingRebuy || 0))
    : gamePlayer?.stack ?? (member?.pendingRebuy || member?.stack || 0);
  const isDealer = game?.buttonSeat === index;
  const isSmallBlind = game?.smallBlindSeat === index;
  const isBigBlind = game?.bigBlindSeat === index;
  const winner = game?.winners?.find((candidate) => candidate.userId === member?.userId);
  const classes = ["player-seat", `seat-${index}`, active ? "active-turn" : "", gamePlayer?.folded ? "folded" : "", !member ? "empty" : "", selected ? "selected-seat" : "", spectatorFocused ? "spectator-focused" : "", spectatorMystery ? "spectator-mystery" : "", spectatorPrivate ? "spectator-private" : ""].join(" ");
  const canWatch = Boolean(member && gamePlayer && onWatchPlayer && !gamePlayer.folded && !spectatorMystery && !spectatorPrivate);
  const SeatSurface = !member && onSelectSeat ? "button" : "div";
  const watchPlayer = canWatch ? () => onWatchPlayer(member.userId) : undefined;
  return (
    <div
      className={`${classes} ${canWatch ? "watchable-player" : ""}`.trim()}
      role={canWatch ? "button" : undefined}
      tabIndex={canWatch ? 0 : undefined}
      aria-label={canWatch ? `观看 ${member.username} 的手牌` : undefined}
      onClick={watchPlayer}
      onKeyDown={canWatch ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          watchPlayer();
        }
      } : undefined}
    >
      {gamePlayer?.bet > 0 && <Chip amount={gamePlayer.bet} />}
      <SeatSurface
        className="seat-card"
        type={SeatSurface === "button" ? "button" : undefined}
        onClick={!member && onSelectSeat ? () => onSelectSeat(index) : undefined}
      >
        {!member ? (
          <span className="empty-seat-label"><b>{index + 1}</b><small>{selected ? "已选择" : "空位"}</small></span>
        ) : (
          <>
            {member.characterId
              ? <img className="seat-avatar seat-character-avatar" src={characterImage(member.characterId, characterState?.awakened)} alt="" />
              : <PlayerAvatar name={member.username} tone={member.avatarTone} className="seat-avatar" />}
            <span className="seat-copy">
              <strong>{member.isSelf ? "你" : member.username}</strong>
              <small>{formatChips(stack)}</small>
              {member.title && member.title !== DEFAULT_PLAYER_TITLE && <em>{member.title}</em>}
            </span>
            <span className="seat-badges">
              {isDealer && <b>D</b>}
              {isSmallBlind && <b>SB</b>}
              {isBigBlind && <b>BB</b>}
            </span>
            {gamePlayer?.allIn && <span className="allin-badge">ALL IN</span>}
            {!game && member.isBot && onRemoveBot && (
              <button className="remove-bot" onClick={() => onRemoveBot(member.userId)} aria-label={`移除${member.username}`}><X size={12} /></button>
            )}
          </>
        )}
      </SeatSurface>
      {canWatch && !spectatorFocused && (
        <span className="watch-seat-hint" aria-hidden="true">
          <Eye size={12} />
          <span>查看手牌</span>
        </span>
      )}
      {member && gamePlayer?.cardCount > 0 && (!member.isSelf || dealingHoleCards) && (
        <span className={`seat-hole-cards ${dealingHoleCards ? "dealing" : ""}`} aria-label={gamePlayer.cards.length ? `${member.username} 的${game?.stage === "finished" ? "摊牌" : "观战"}手牌` : `${member.username} 的底牌`}>
          {dealingHoleCards
            ? Array.from({ length: gamePlayer.cardCount }, (_, cardIndex) => (
              <PlayingCard
                key={cardIndex}
                hidden
                small
                className={dealingHoleCards ? "dealing-hole-card" : ""}
                style={dealingHoleCards ? {
                  "--deal-delay": `${holeCardDealDelayMs(dealOrderIndex, cardIndex, dealPlayerCount)}ms`,
                  "--deal-flight": `${HOLE_CARD_DEAL_TIMING.flightMs}ms`,
                } : undefined}
              />
            ))
            : gamePlayer.cards.length
              ? gamePlayer.cards.map((card) => <PlayingCard key={card} card={card} small />)
              : Array.from({ length: gamePlayer.cardCount }, (_, cardIndex) => <PlayingCard key={cardIndex} hidden small />)}
        </span>
      )}
      {gamePlayer?.acted && !active && !gamePlayer.folded && game?.stage !== "finished" && <span className="acted-badge"><Check size={11} /></span>}
      {winner && <span className="seat-winner"><strong>+{formatChips(winner.amount)}</strong><small>{winner.handName}</small></span>}
    </div>
  );
}

function TableSurface({ room, game, onRemoveBot, onSelectSeat, onWatchPlayer, selectedSeat, dealingHoleCards = false, children }) {
  const membersBySeat = useMemo(() => {
    const map = new Map();
    room.members.filter((member) => member.role === "player").forEach((member) => map.set(member.seat, member));
    return map;
  }, [room.members]);
  const dealOrderBySeat = useMemo(() => new Map(
    holeCardDealOrder(game?.players, game?.buttonSeat).map((seat, orderIndex) => [seat, orderIndex]),
  ), [game?.buttonSeat, game?.handId, game?.players]);
  const reservesBottomHand = Boolean(game && game.stage !== "finished");
  return (
    <div className={`table-wrap ${dealingHoleCards ? "dealing-hole-cards" : ""} ${reservesBottomHand ? "hand-runway" : ""}`.trim()}>
      <div className={`poker-table ${dealingHoleCards ? "dealing-hole-cards" : ""}`}>
        <div className="felt-line" aria-hidden="true" />
        <div className="table-center">{children}</div>
      </div>
      {Array.from({ length: 8 }, (_, index) => (
        <PlayerSeat
          key={index}
          index={index}
          member={membersBySeat.get(index)}
          gamePlayer={game?.players.find((player) => player.seat === index)}
          characterState={room.hextech?.characters?.find((character) => character.userId === membersBySeat.get(index)?.userId)}
          game={game}
          onRemoveBot={onRemoveBot}
          onSelectSeat={index < room.settings.maxPlayers ? onSelectSeat : null}
          onWatchPlayer={onWatchPlayer}
          selected={selectedSeat === index}
          dealingHoleCards={dealingHoleCards}
          dealOrderIndex={dealOrderBySeat.get(index) ?? 0}
          dealPlayerCount={game?.players.length ?? 2}
          spectatorFocused={Boolean(game?.spectatorView?.focusUserId) && game.spectatorView.focusUserId === membersBySeat.get(index)?.userId}
          spectatorMystery={Boolean(game?.spectatorView?.mysteryUserId) && game.spectatorView.mysteryUserId === membersBySeat.get(index)?.userId}
          spectatorPrivate={Boolean(game?.spectatorView) && (() => {
            const viewedPlayer = game?.players.find((player) => player.seat === index);
            return Boolean(viewedPlayer?.spectatorHidden && !viewedPlayer?.spectatorAccessGranted);
          })()}
        />
      ))}
    </div>
  );
}

function RoomHeader({ room, user, onLeave, onCopy, onToggleSidebar, onOpenPreferences, onOpenProfile, onOpenSkillLibrary, voiceAnnouncements, onToggleVoiceAnnouncements }) {
  const [copied, setCopied] = useState(false);
  const playerCount = room.members.filter((member) => member.role === "player").length;
  const spectatorCount = room.members.filter((member) => member.role === "spectator").length;

  async function copyRoomCode() {
    await onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  }

  return (
    <header className="room-header">
      <div className="room-title-group">
        <button className="icon-button mobile-only" onClick={onLeave} aria-label="返回大厅"><X size={20} /></button>
        <span className="room-brand desktop-only"><Spade size={22} /></span>
        <div><p className="eyebrow">{room.mode === ROOM_MODES.HEXTECH_CHAOS ? `海克斯大乱德 · 第 ${room.handNumber || 1} 手` : room.game && room.game.stage !== "finished" ? `第 ${room.handNumber} 局` : "私人房间"}</p><h1>{room.name}</h1></div>
      </div>
      <div className="room-meta">
        <button className="room-code" onClick={copyRoomCode} data-state={copied ? "copied" : "idle"}><span>{copied ? "已复制" : `房间 ${room.code}`}</span>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
        <span><Users size={16} /> {playerCount}/{room.settings.maxPlayers}</span>
        <span><Eye size={16} /> {spectatorCount}</span>
      </div>
      <div className="room-header-actions">
        {onOpenSkillLibrary && <button className="hextech-library-header-entry" onClick={onOpenSkillLibrary} aria-label="查看公共技能图鉴"><BookOpen size={17} /><span>技能图鉴</span></button>}
        <button className="room-profile-entry" onClick={onOpenProfile} aria-label="打开个人资料" title="个人资料">
          <PlayerAvatar user={user} /><span>{displayName(user)}</span><UserRound size={15} />
        </button>
        {room.mode !== ROOM_MODES.HEXTECH_CHAOS && <VoiceAnnouncementsButton enabled={voiceAnnouncements} onToggle={onToggleVoiceAnnouncements} />}
        <PreferencesButton onClick={onOpenPreferences} />
        <button className="button ghost desktop-only" onClick={onLeave}>返回大厅</button>
        <button className="icon-button mobile-only" onClick={onToggleSidebar} aria-label="打开玩家和聊天"><Menu size={21} /></button>
      </div>
    </header>
  );
}

function WaitingRoom({ room, act }) {
  const isHost = room.hostUserId === room.self.userId;
  const isHextech = room.mode === ROOM_MODES.HEXTECH_CHAOS;
  const playerMembers = room.members.filter((member) => member.role === "player");
  const unreadyPlayers = playerMembers.filter((member) => !member.isBot && !member.ready);
  const missingCharacterPlayers = isHextech ? playerMembers.filter((member) => !member.characterId) : [];
  const requests = room.members.filter((member) => member.seatRequest);
  const canReady = room.self.role === "player"
    && (room.self.stack > 0 || room.self.pendingRebuy > 0)
    && (!isHextech || Boolean(room.self.characterId));
  const canStart = playerMembers.length >= 2
    && (!isHextech || (unreadyPlayers.length === 0 && missingCharacterPlayers.length === 0));
  const onRemoveBot = isHost ? (userId) => act("room:remove-bot", { userId }) : null;

  return (
    <div className={`game-layout waiting-layout ${isHextech ? "hextech-waiting-layout" : ""}`}>
      <section className="table-column">
        <TableSurface room={room} game={null} onRemoveBot={onRemoveBot}>
          <div className="waiting-center">
            {isHextech ? <Sparkles size={30} strokeWidth={1.5} /> : <Spade size={30} strokeWidth={1.5} />}
            <strong>{playerMembers.length < 2 ? "等待玩家加入" : missingCharacterPlayers.length > 0 ? `等待 ${missingCharacterPlayers.length} 位玩家选人物` : unreadyPlayers.length > 0 ? `等待 ${unreadyPlayers.length} 位玩家准备` : "牌桌已经就绪"}</strong>
            <span>{isHextech ? `初始 2,000 · 当前人数目标 ${formatChips(room.hextech.targetChips)} · 最多 15 手` : `买入 ${formatChips(room.settings.initialChips)} · 在桌上限 ${formatChips(room.settlement.tableCap)} · 盲注 ${room.settings.smallBlind}/${room.settings.bigBlind}`}</span>
          </div>
        </TableSurface>
        {isHextech && room.self.role === "player" && <HextechCharacterSelect room={room} act={act} />}
        <div className="waiting-actions">
          {room.self.role === "player" ? (
            <button className={`button ${room.self.ready ? "secondary" : "primary"}`} disabled={!canReady} onClick={() => act("room:ready", { ready: !room.self.ready })}>
              {room.self.ready ? <><Check size={19} /> 已准备</> : "准备"}
            </button>
          ) : (
            <button className="button primary" disabled={room.self.seatRequest} onClick={() => act("room:request-seat")}>
              <UserPlus size={19} /> {room.self.seatRequest ? "已申请下一局入座" : "申请下一局入座"}
            </button>
          )}
          {isHost && <button className="button secondary" onClick={() => act("room:add-bot")} disabled={playerMembers.length >= room.settings.maxPlayers}><Plus size={19} /> 添加测试玩家</button>}
          {isHost && (isHextech
            ? <button className="button primary waiting-start-button" onClick={() => act("room:start")} disabled={!canStart}>开始首手并发放技能</button>
            : <button className="button primary waiting-start-button" onClick={() => act("room:start")} disabled={!canStart}>开始发牌</button>)}
          {missingCharacterPlayers.length > 0 && (
            <p className="waiting-ready-hint"><Sparkles size={16} /> 未选人物：{missingCharacterPlayers.map((member) => member.isSelf ? `${member.username}（你）` : member.username).join("、")}</p>
          )}
          {unreadyPlayers.length > 0 && (
            <p className="waiting-ready-hint"><Users size={16} /> 未准备：{unreadyPlayers.map((member) => member.isSelf ? `${member.username}（你）` : member.username).join("、")}</p>
          )}
        </div>
        {requests.length > 0 && isHost && (
          <div className="seat-requests">
            <strong>下一局入座申请</strong>
            {requests.map((member) => (
              <div key={member.userId}><span>{member.username}</span><button className="button compact" onClick={() => act("room:approve-seat", { userId: member.userId })}>允许入座</button></div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RejoinWaiting({ room, act }) {
  const isHost = room.hostUserId === room.self.userId;
  const playerCount = room.members.filter((member) => member.role === "player").length;
  return (
    <section className="table-column rejoin-waiting">
      <TableSurface room={room} game={null}>
        <div className="waiting-center">
          <Check size={30} />
          <strong>下一局开始前</strong>
          <span>补充的 {formatChips(room.self.pendingRebuy)} 筹码已到账，准备后从下一局生效。</span>
        </div>
      </TableSurface>
      <div className="waiting-actions rejoin-waiting-actions">
        <div className="rejoin-waiting-status"><span>已入座</span><strong>筹码 {formatChips(room.self.pendingRebuy)}</strong></div>
        <button className={`button ${room.self.ready ? "secondary" : "primary"}`} onClick={() => act("room:ready", { ready: !room.self.ready })}>
          {room.self.ready ? <><Check size={18} /> 已准备</> : "准备"}
        </button>
        {isHost && <button className="button primary" disabled={playerCount < 2} onClick={() => act("room:start")}>开始下一局</button>}
      </div>
    </section>
  );
}

function SeatSelection({ room, act, onContinue }) {
  const occupiedSeats = useMemo(
    () => new Set(room.members.filter((member) => member.role === "player").map((member) => member.seat)),
    [room.members],
  );
  const firstAvailableSeat = useMemo(
    () => Array.from({ length: room.settings.maxPlayers }, (_, index) => index).find((index) => !occupiedSeats.has(index)) ?? null,
    [occupiedSeats, room.settings.maxPlayers],
  );
  const [selectedSeat, setSelectedSeat] = useState(firstAvailableSeat);

  useEffect(() => {
    if (selectedSeat == null || occupiedSeats.has(selectedSeat)) setSelectedSeat(firstAvailableSeat);
  }, [firstAvailableSeat, occupiedSeats, selectedSeat]);

  async function requestSelectedSeat() {
    if (selectedSeat == null) return;
    const result = await act("room:request-seat", { seat: selectedSeat });
    if (result) onContinue();
  }

  return (
    <section className="entry-flow seat-selection-flow">
      <header className="entry-flow-heading">
        <div><p className="eyebrow">入座选择</p><h2>选择一个空位</h2></div>
        <span>玩家 {room.members.filter((member) => member.role === "player").length}/{room.settings.maxPlayers} · 观战 {room.members.filter((member) => member.role === "spectator").length}</span>
      </header>
      <TableSurface room={room} game={null} onSelectSeat={setSelectedSeat} selectedSeat={selectedSeat}>
        <div className="waiting-center">
          <UserPlus size={28} />
          <strong>{selectedSeat == null ? "当前没有空位" : `已选择 ${selectedSeat + 1} 号座位`}</strong>
          <span>提交后等待房主确认；确认成功后从下一局开始入座。</span>
        </div>
      </TableSurface>
      <div className="entry-flow-actions">
        <button className="button primary" disabled={selectedSeat == null} onClick={requestSelectedSeat}><UserPlus size={18} /> 申请入座</button>
        <button className="button secondary" onClick={onContinue}><Eye size={18} /> 继续观战</button>
      </div>
    </section>
  );
}

function SpectatorWaiting({ room, onChooseSeat, onLeave }) {
  const spectators = room.members.filter((member) => member.role === "spectator");
  const hasOpenSeat = room.members.filter((member) => member.role === "player").length < room.settings.maxPlayers;
  return (
    <section className="entry-flow spectator-waiting-flow">
      <header className="entry-flow-heading">
        <div><p className="eyebrow">观战席</p><h2>等待牌局开始</h2></div>
        <span>观战人数 {spectators.length}</span>
      </header>
      <div className="spectator-roster">
        {spectators.map((member) => (
          <div className="spectator-roster-row" key={member.userId}>
            <span className="avatar spectator"><Eye size={15} /></span>
            <span><strong>{member.isSelf ? `${member.username}（你）` : member.username}</strong><small>{member.seatRequest ? "等待房主确认" : "正在观战"}</small></span>
          </div>
        ))}
      </div>
      <div className="spectator-wait-notice">
        <CircleDollarSign size={24} />
        <div><strong>{hasOpenSeat ? "可申请下一局入座" : "玩家席当前已满"}</strong><p>开局后可以切换玩家视角查看手牌；每局会随机保留一位神秘玩家。</p></div>
      </div>
      <div className="entry-flow-actions">
        <button className="button primary" disabled={!hasOpenSeat || room.self.seatRequest} onClick={onChooseSeat}><UserPlus size={18} /> 选择座位并申请入座</button>
        <button className="button secondary" onClick={onLeave}>返回大厅</button>
      </div>
    </section>
  );
}

function SeatRequestConfirmation({ room }) {
  const requests = room.members.filter((member) => member.seatRequest);
  return (
    <section className="entry-flow seat-request-confirmation">
      <div className="confirmation-copy">
        <span className="confirmation-mark"><Check size={34} /></span>
        <h2>下一局入座申请已提交</h2>
        <p>等待房主确认</p>
      </div>
      <div className="confirmation-table">
        <TableSurface room={room} game={null}>
          <div className="waiting-center"><Spade size={24} /><strong>下一局开始前</strong><span>房主确认后，请在牌桌上点击准备。</span></div>
        </TableSurface>
      </div>
      <div className="seat-queue">
        <div className="seat-queue-heading"><strong>排队观战者</strong><span>{requests.length} 人</span></div>
        {requests.map((member, index) => (
          <div className="seat-queue-row" key={member.userId}>
            <b>{index + 1}</b><span>{member.isSelf ? `${member.username}（你）` : member.username}</span><small>{member.isSelf ? "已提交" : "等待中"}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function RaisePanel({ legal, game, bigBlind, onClose, onConfirm }) {
  const [value, setValue] = useState(legal.minRaiseTo);
  const [manualValue, setManualValue] = useState(String(legal.minRaiseTo));
  const [activePreset, setActivePreset] = useState("minimum");
  const actingPlayer = game.players.find((player) => player.seat === game.actingSeat);

  const normalizeValue = (nextValue) => normalizeRaiseTarget(nextValue, legal);

  const updateValue = (nextValue, presetId = null) => {
    const normalized = normalizeValue(nextValue);
    setValue(normalized);
    setManualValue(String(normalized));
    setActivePreset(presetId);
  };

  useEffect(() => {
    setValue(legal.minRaiseTo);
    setManualValue(String(legal.minRaiseTo));
    setActivePreset("minimum");
  }, [legal.minRaiseTo, legal.maxRaiseTo]);

  const handleManualChange = (event) => {
    const nextValue = event.target.value;
    setManualValue(nextValue);
    setActivePreset(null);
    if (nextValue !== "" && Number.isFinite(Number(nextValue))) {
      setValue(normalizeValue(nextValue));
    }
  };

  const confirmRaise = () => {
    const normalized = normalizeValue(manualValue === "" ? value : manualValue);
    setValue(normalized);
    setManualValue(String(normalized));
    onConfirm(normalized);
  };

  const presets = useMemo(() => buildRaisePresets({
    legal,
    pot: game.pot,
    currentBet: game.currentBet,
    playerBet: actingPlayer?.bet ?? 0,
    bigBlind,
  }), [actingPlayer?.bet, bigBlind, game.currentBet, game.pot, legal]);
  return (
    <div className="raise-panel" role="dialog" aria-labelledby="raise-panel-title">
      <div className="raise-panel-header"><span id="raise-panel-title">加注至</span><strong>{formatChips(value)}</strong><button className="icon-button" onClick={onClose} aria-label="关闭加注"><X size={18} /></button></div>
      <div className="raise-control">
        <button onClick={() => updateValue(value - CHIP_UNIT)} aria-label="减少加注"><Minus size={18} /></button>
        <input type="range" min={legal.minRaiseTo} max={legal.maxRaiseTo} step={CHIP_UNIT} value={value} onChange={(event) => updateValue(event.target.value)} aria-label="拖动选择加注值" />
        <button onClick={() => updateValue(value + CHIP_UNIT)} aria-label="增加加注"><Plus size={18} /></button>
      </div>
      <label className="raise-manual-field">
        <span>手动输入</span>
        <span className="raise-manual-input">
          <input
            type="number"
            inputMode="numeric"
            min={legal.minRaiseTo}
            max={legal.maxRaiseTo}
            step={CHIP_UNIT}
            value={manualValue}
            onChange={handleManualChange}
            onBlur={() => updateValue(manualValue === "" ? value : manualValue)}
            aria-label="手动输入加注值"
          />
          <small>筹码</small>
        </span>
        <small>输入 {formatChips(legal.minRaiseTo)}–{formatChips(legal.maxRaiseTo)}，以 {CHIP_UNIT} 为单位</small>
      </label>
      <div className="raise-presets" aria-label="赛事快捷加注">
        {presets.map((preset) => (
          <button
            type="button"
            className={activePreset === preset.id ? "active" : ""}
            aria-pressed={activePreset === preset.id}
            onClick={() => updateValue(preset.value, preset.id)}
            key={preset.id}
          >
            <strong>{preset.label}</strong>
            <small>{preset.detail} · {formatChips(preset.value)}</small>
          </button>
        ))}
      </div>
      <button className="button primary wide" onClick={confirmRaise}>确认加注</button>
    </div>
  );
}

function ActionBar({ game, bigBlind, act, allowTimeExtension = true }) {
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const legal = game.legal;
  const submitAction = (action, amount) => act("game:action", {
    action,
    ...(amount == null ? {} : { amount }),
    handId: game.handId,
    actionToken: game.actionToken,
  });
  useEffect(() => {
    setRaiseOpen(false);
    setExtensionBusy(false);
  }, [game.actingSeat, game.stage]);
  if (!legal) return (
    <div className="action-area is-waiting">
      <div className="action-waiting">{
        game.stage === "finished"
          ? "本局已经结束"
          : game.runout?.active
            ? "全押摊牌 · 公共牌逐街发出"
            : "等待其他玩家行动"
      }</div>
    </div>
  );
  const allInOnly = !legal.canRaise && legal.canAllIn;
  const timeExtension = game.timeExtension;
  const extensionUsed = Boolean(timeExtension?.used);
  const actingPlayer = game.players.find((player) => player.seat === game.actingSeat);
  const extensionInsufficient = !extensionUsed
    && actingPlayer?.stack < Number(timeExtension?.cost ?? 500) + CHIP_UNIT;

  async function buyTimeExtension() {
    if (!timeExtension?.canBuy || extensionBusy) return;
    setExtensionBusy(true);
    try {
      await act("game:time-extension", {
        handId: game.handId,
        actionToken: game.actionToken,
      });
    } finally {
      setExtensionBusy(false);
    }
  }

  return (
    <div className="action-area">
      {raiseOpen && (
        <div className="raise-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRaiseOpen(false); }}>
          <RaisePanel legal={legal} game={game} bigBlind={bigBlind} onClose={() => setRaiseOpen(false)} onConfirm={(amount) => { setRaiseOpen(false); submitAction("raise", amount); }} />
        </div>
      )}
      {allowTimeExtension && <div className={`time-extension-row ${extensionUsed ? "used" : ""}`}>
        <span className="time-extension-copy">
          <TimerReset size={18} />
          <span><strong>加时卡</strong><small>本回合增加 {timeExtension?.seconds ?? 60} 秒，费用不计入底池</small></span>
        </span>
        <button
          className="time-extension-button"
          disabled={!timeExtension?.canBuy || extensionBusy}
          onClick={buyTimeExtension}
          title={extensionInsufficient ? `购买后需要至少保留 ${CHIP_UNIT} 筹码` : undefined}
        >
          {extensionBusy
            ? "购买中…"
            : extensionUsed
              ? <>已加时 <b>+{timeExtension?.seconds ?? 60}s</b></>
              : extensionInsufficient
                ? "筹码不足"
                : <>购买 <b>{formatChips(timeExtension?.cost ?? 500)}</b></>}
        </button>
      </div>}
      <div className="action-bar">
        <button className="action-button fold" onClick={() => submitAction("fold")}>弃牌</button>
        <button className="action-button check" disabled={!legal.canCheck} onClick={() => submitAction("check")}>过牌</button>
        <button className="action-button call" disabled={!legal.canCall} onClick={() => submitAction("call")}>{legal.canCall ? `跟注 ${formatChips(legal.toCall)}` : "跟注"}</button>
        <button
          className={`action-button ${allInOnly ? "allin" : "raise"}`}
          disabled={!legal.canRaise && !legal.canAllIn}
          onClick={() => allInOnly ? submitAction("allin") : setRaiseOpen(true)}
        >
          {allInOnly ? "全押" : <>加注 <ChevronDown size={16} /></>}
        </button>
      </div>
    </div>
  );
}

function TurnTimer({ deadline, duration = 30 }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const total = Math.max(1, Number(duration) || 30);
  const seconds = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
  const progress = Math.max(0, Math.min(1, seconds / total));
  return <span className="turn-timer" style={{ "--turn-progress": `${progress * 360}deg` }}>{seconds}</span>;
}

function CommunityCards({ game }) {
  return (
    <div className="community-cards" aria-label="公共牌">
      {game.community.map((card) => <PlayingCard key={card} card={card} entering />)}
    </div>
  );
}

function DealerDeck({ visible }) {
  if (!visible) return null;
  return (
    <span className="dealer-deck" aria-hidden="true">
      <span className="dealer-deck-card card-one" />
      <span className="dealer-deck-card card-two" />
      <span className="dealer-deck-card card-three" />
    </span>
  );
}

function HandTimeline({ stage }) {
  const stages = [
    { id: "preflop", label: "底牌" },
    { id: "flop", label: "翻牌" },
    { id: "turn", label: "转牌" },
    { id: "river", label: "河牌" },
  ];
  const currentIndex = stage === "finished" ? stages.length : Math.max(0, stages.findIndex((item) => item.id === stage));
  return (
    <div className="hand-timeline" aria-label="本局发牌阶段">
      {stages.map((item, index) => (
        <span key={item.id} className={index < currentIndex ? "complete" : index === currentIndex ? "active" : ""}><b>{index + 1}</b>{item.label}</span>
      ))}
    </div>
  );
}

function OwnCards({ room, game, act, folded = false }) {
  const [peeked, setPeeked] = useState(false);
  const [showType, setShowType] = useState(false);
  useEffect(() => {
    setPeeked(folded);
    setShowType(false);
  }, [folded, room.handNumber]);
  const self = game.players.find((player) => player.userId === room.self.userId);
  if (!self || !self.cardCount) return null;
  const canReveal = self.cards.length > 0;
  const ranks = self.cards.map((card) => card.slice(0, -1));
  const suits = self.cards.map((card) => card.at(-1));
  const startingHand = ranks.length < 2 ? "等待发牌" : ranks[0] === ranks[1] ? "口袋对子" : suits[0] === suits[1] ? "同花起手牌" : "非同花起手牌";
  function togglePeek() {
    const nextPeeked = !peeked;
    setPeeked(nextPeeked);
    setShowType(false);
    if (!folded) {
      act("game:spectator-visibility", { hidden: !nextPeeked, handId: game.handId });
    }
  }
  return (
    <div className={`own-cards ${folded ? "folded-hand-review" : ""}`}>
      <button className="own-card-stack" onClick={togglePeek} aria-label={peeked ? (folded ? "隐藏原手牌" : "隐藏手牌") : (folded ? "查看原手牌" : "查看手牌")}>
        {canReveal && peeked
          ? self.cards.map((card) => <PlayingCard key={card} card={card} />)
          : Array.from({ length: self.cardCount }, (_, index) => <PlayingCard key={index} hidden />)}
      </button>
      <span className="own-card-controls">
        <button className="peek-label" onClick={togglePeek}>{peeked ? <><EyeOff size={15} /> {folded ? "已弃牌 · 隐藏原手牌" : "隐藏手牌"}</> : <><Eye size={15} /> {folded ? "查看原手牌" : "点击看牌"}</>}</button>
        <button className="hand-type-button" disabled={!peeked} onClick={() => setShowType((value) => !value)}>查看牌型</button>
        {!folded && <span
          className={`spectator-privacy-state ${self.spectatorHidden ? "private" : ""}`}
          title={self.spectatorHidden ? "仅阻止本手尚未看过你手牌的观战者；已经看过的人仍可继续查看" : "观战者可以申请查看你的手牌"}
        ><LockKeyhole size={12} /> {self.spectatorHidden ? "阻止新观战" : "观战可见"}</span>}
      </span>
      {showType && <span className="hand-type-note">起手牌：{startingHand}</span>}
    </div>
  );
}

function SpectatorHand({ game }) {
  const focused = game.players.find((player) => player.userId === game.spectatorView?.focusUserId);
  if (!focused || focused.cards.length === 0) {
    return (
      <div className="spectator-hand spectator-hand-empty" role="status">
        <LockKeyhole size={17} />
        <span><strong>当前没有可观看的手牌</strong><small>请选择仍在本局中的其他玩家</small></span>
      </div>
    );
  }
  return (
    <div className="spectator-hand" role="status" aria-label={`正在观看 ${focused.username} 的手牌`}>
      <span className="spectator-hand-cards">
        {focused.cards.map((card) => <PlayingCard key={card} card={card} />)}
      </span>
      <span className="spectator-hand-copy"><Eye size={14} /><strong>{focused.username}</strong><small>观战视角</small></span>
    </div>
  );
}

function ActionLog({ game, compact = false }) {
  return (
    <div className={`action-log ${compact ? "compact" : ""}`}>
      <div className="action-log-heading"><strong>行动记录</strong><span>{game.stageLabel}</span></div>
      <div className="action-log-list">
        {game.actionLog.length === 0 && <p className="muted-copy">等待第一位玩家行动</p>}
        {game.actionLog.slice(0, compact ? 6 : 12).map((entry, index) => (
          <div className="action-log-row" key={`${entry.at}-${index}`}><span>{entry.actor}</span><strong>{entry.text}</strong></div>
        ))}
      </div>
    </div>
  );
}

function FoldRevealChoice({ game, act }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!game.foldReveal?.deadline || game.foldReveal.decision != null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [game.foldReveal?.deadline, game.foldReveal?.decision]);
  if (!game.foldReveal || game.foldReveal.decision != null) return null;
  const seconds = Math.max(0, Math.ceil((game.foldReveal.deadline - now) / 1000));
  const winner = game.players.find((player) => player.userId === game.foldReveal.winnerUserId);
  if (!game.foldReveal.canChoose) {
    return (
      <div className="fold-reveal-waiting" role="status">
        <Eye size={17} />
        <span><strong>{winner?.username ?? "获胜玩家"} 正在决定是否亮牌</strong><small>{seconds} 秒后默认不亮牌</small></span>
      </div>
    );
  }
  return (
    <div className="fold-reveal-choice" role="group" aria-label="弃牌获胜后的亮牌选择">
      <span className="fold-reveal-hand">
        {(winner?.cards ?? []).map((card) => <PlayingCard key={card} card={card} small />)}
      </span>
      <span className="fold-reveal-copy"><strong>要把这手牌翻给大家看吗？</strong><small>{seconds} 秒后默认不亮牌</small></span>
      <span className="fold-reveal-actions">
        <button className="button secondary" disabled={seconds <= 0} onClick={() => act("game:fold-reveal", { reveal: false, handId: game.handId })}>不翻</button>
        <button className="button primary" disabled={seconds <= 0} onClick={() => act("game:fold-reveal", { reveal: true, handId: game.handId })}><Eye size={16} /> 翻给大家看</button>
      </span>
    </div>
  );
}

function ResultCard({ room, game, act, onRebuy, onSpectate }) {
  if (game.stage !== "finished") return null;
  const isHost = room.hostUserId === room.self.userId;
  const isHextech = room.mode === ROOM_MODES.HEXTECH_CHAOS;
  const busted = room.self.role === "player" && room.self.stack === 0 && room.self.pendingRebuy === 0;
  const rejoining = room.self.role === "player" && room.self.stack === 0 && room.self.pendingRebuy > 0;
  const lowStack = room.self.role === "player"
    && !isHextech
    && room.self.stack > 0
    && room.self.stack < LOW_STACK_REBUY_THRESHOLD
    && room.self.pendingRebuy === 0;
  const pendingTopUp = room.self.role === "player" && room.self.stack > 0 && room.self.pendingRebuy > 0;
  const foldRevealPending = Boolean(game.foldReveal && game.foldReveal.decision == null);
  const remaining = room.settings.maxRebuys - room.self.rebuyCount;
  const playerCount = room.members.filter((member) => member.role === "player").length;
  const selfResultPlayer = game.players.find((player) => player.userId === room.self.userId);
  const foldedCards = selfResultPlayer?.folded ? selfResultPlayer.cards : [];
  const selfCashOut = room.settlement.lastHandCashOuts
    .find((entry) => entry.userId === room.self.userId)?.amount ?? 0;

  if (rejoining) {
    return (
      <div className="result-card compact-result-card rejoin-ready-card">
        <div className="result-summary rejoin-summary">
          <span className="confirmation-mark compact-mark"><Check size={20} /></span>
          <span className="result-summary-copy">
            <small>下一局等待</small>
            <strong>已入座 · 筹码 {formatChips(room.self.pendingRebuy)}</strong>
            <em>补充筹码将在下一局发牌前生效</em>
          </span>
        </div>
        <div className="result-footer result-actions">
          <button className={`button ${room.self.ready ? "secondary" : "primary"}`} onClick={() => act("room:ready", { ready: !room.self.ready })}>
            {room.self.ready ? <><Check size={18} /> 已准备</> : "准备"}
          </button>
          {isHost && <button className="button primary waiting-start-button" disabled={playerCount < 2} onClick={() => act("room:start")}>开始下一局</button>}
        </div>
      </div>
    );
  }

  return (
    <div className={`result-card compact-result-card ${busted ? "busted-result" : ""}`}>
      <div className={`result-summary ${selfCashOut > 0 ? "has-cashout" : ""}`}>
        <span className="result-summary-copy">
          <small>{busted ? "筹码归零" : "本局结束"}</small>
          <strong>{game.winners.map((winner) => winner.username).join("、")} 赢得底池</strong>
          {busted && <em>{room.settings.allowRebuy && remaining > 0 ? `可补充 ${formatChips(room.settings.rebuyAmount)} 筹码或转为观战` : "补充次数已用完，可转为观战"}</em>}
          {lowStack && <em>当前筹码低于 {formatChips(LOW_STACK_REBUY_THRESHOLD)}，可在下一局前补充</em>}
          {pendingTopUp && <em>已补充 {formatChips(room.self.pendingRebuy)}，下一局筹码共 {formatChips(room.self.stack + room.self.pendingRebuy)}</em>}
        </span>
        {foldedCards.length > 0 && (
          <span className="result-folded-hand" aria-label={`你的弃牌 ${foldedCards.join(" ")}`}>
            <small>你的弃牌</small>
            <span>{foldedCards.map((card) => <PlayingCard key={card} card={card} small />)}</span>
          </span>
        )}
        <div className="winner-list">
          {game.winners.map((winner) => <span key={winner.userId}><strong>+{formatChips(winner.amount)}</strong><small>{winner.handName}</small></span>)}
        </div>
        {selfCashOut > 0 && (
          <span className="result-cashout">
            <CircleDollarSign size={16} />
            <span><small>系统卖出</small><strong>+{formatChips(selfCashOut)}</strong></span>
          </span>
        )}
      </div>
      {foldRevealPending ? (
        <FoldRevealChoice game={game} act={act} />
      ) : busted ? (
        <div className="result-footer result-actions">
          <button className="button primary" disabled={!room.settings.allowRebuy || remaining <= 0} onClick={onRebuy}>补充筹码 {formatChips(room.settings.rebuyAmount)}</button>
          <button className="button secondary" onClick={onSpectate}><Eye size={18} /> 转为观战</button>
        </div>
      ) : (
        <div className={`result-footer ${lowStack || pendingTopUp ? "result-actions" : ""}`}>
          {lowStack && <button className="button secondary" disabled={!room.settings.allowRebuy || remaining <= 0} onClick={onRebuy}>补充筹码 {formatChips(room.settings.rebuyAmount)}</button>}
          {pendingTopUp && <span className="low-stack-rebuy-status"><Check size={17} /> 补筹已提交</span>}
          {isHost && <button className="button primary wide" onClick={() => act("room:start")}>开始下一局</button>}
          {!isHost && <p className="result-waiting">等待房主开始下一局</p>}
        </div>
      )}
    </div>
  );
}

function RebuyCountdown({ deadline }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.ceil((Number(deadline || now) - now) / 1000));
}

function EndOfHandFlow({ room, game, act, phase, setPhase }) {
  if (game.stage !== "finished") return null;
  const isHextech = room.mode === ROOM_MODES.HEXTECH_CHAOS;
  const remaining = room.settings.maxRebuys - room.self.rebuyCount;
  const queuedRebuy = room.self.role === "spectator" && room.self.pendingRebuy > 0 && room.self.seatRequest;
  const lowStackTopUp = !isHextech && room.self.role === "player" && room.self.stack > 0;
  const effectivePhase = phase ?? (queuedRebuy ? "seat" : null);
  const queue = room.members.filter((member) => member.role === "spectator" && member.seatRequest);

  async function confirmRebuy() {
    const result = await act("game:rebuy", { accept: true });
    if (result) setPhase("success");
  }

  async function confirmSpectate() {
    const result = await act("game:rebuy", { accept: false });
    if (result) setPhase(null);
  }

  async function confirmSeat() {
    const result = await act("room:confirm-next-seat");
    if (result) setPhase(null);
  }

  async function continueWatching() {
    const result = await act("room:defer-seat");
    if (result) setPhase(null);
  }

  if (effectivePhase === "spectate") {
    return (
      <div className="modal-backdrop">
        <section className="modal rebuy-modal" role="dialog" aria-modal="true" aria-labelledby="spectate-confirm-title">
          <span className="rebuy-chip spectator-chip"><Eye size={30} /></span>
          <p className="eyebrow">不补充筹码</p>
          <h2 id="spectate-confirm-title">转为观战？</h2>
          <p>你将退出当前座位，下一局仍可重新申请入座。</p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setPhase(null)}>取消</button>
            <button className="button primary" onClick={confirmSpectate}>转为观战</button>
          </div>
        </section>
      </div>
    );
  }

  if (effectivePhase === "rebuy") {
    return (
      <div className="modal-backdrop">
        <section className="modal rebuy-modal" role="dialog" aria-modal="true" aria-labelledby="rebuy-title">
          <span className="rebuy-chip"><CircleDollarSign size={30} /></span>
          <p className="eyebrow">{lowStackTopUp ? `当前筹码 ${formatChips(room.self.stack)}` : "筹码已用完"}</p>
          <h2 id="rebuy-title">是否补充 {formatChips(room.settings.rebuyAmount)} 筹码？</h2>
          <p>{isHextech ? <>归零后可固定补充 <strong>{formatChips(room.settings.rebuyAmount)}</strong>，下一手开始前到账。本场剩余补充次数 <strong className="danger-number">{Math.max(0, remaining)} 次</strong>；还剩 <strong className="danger-number"><RebuyCountdown deadline={room.self.rebuyDeadline} /> 秒</strong>，超时自动转观战。</> : <>补充筹码将在下一局生效，届时共有 <strong>{formatChips(room.self.stack + room.settings.rebuyAmount)}</strong> 筹码，同时结算点记为 −{formatChips(room.settings.rebuyAmount)}。本场剩余补充次数 <strong className="danger-number">{Math.max(0, remaining)} 次</strong>。</>}</p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setPhase(lowStackTopUp ? null : "spectate")}>暂不补充</button>
            <button className="button primary" disabled={!room.settings.allowRebuy || remaining <= 0} onClick={confirmRebuy}>补充筹码 {formatChips(room.settings.rebuyAmount)}</button>
          </div>
        </section>
      </div>
    );
  }

  if (effectivePhase === "success") {
    return (
      <div className="modal-backdrop">
        <section className="modal rebuy-modal rebuy-success-modal" role="dialog" aria-modal="true" aria-labelledby="rebuy-success-title">
          <span className="confirmation-mark"><Check size={34} /></span>
          <p className="eyebrow">下一局生效</p>
          <h2 id="rebuy-success-title">补充成功</h2>
          <strong className="rebuy-success-amount"><CircleDollarSign size={24} /> {formatChips(room.settings.rebuyAmount)}</strong>
          <p>{lowStackTopUp ? `系统已记入买入账本，下一局开始时筹码将增加至 ${formatChips(room.self.stack + room.self.pendingRebuy)}。` : isHextech ? "补筹已由服务器记录，你已进入下一手入座队列。" : "系统已记入买入账本，你已加入下一局的入座队列。"}</p>
          {!lowStackTopUp && <div className="queue-preview"><span>当前队列</span><strong>{Math.max(1, queue.length)} 人</strong></div>}
          <button className="button primary wide" onClick={() => setPhase(lowStackTopUp ? null : "seat")}>返回牌桌</button>
        </section>
      </div>
    );
  }

  if (effectivePhase === "seat") {
    return (
      <div className="modal-backdrop">
        <section className="modal next-seat-modal" role="dialog" aria-modal="true" aria-labelledby="next-seat-title">
          <div className="next-seat-queue">
            <div className="seat-queue-heading"><strong>入座队列（下一局）</strong><span>{queue.length} 人</span></div>
            {queue.map((member, index) => (
              <div className="seat-queue-row" key={member.userId}>
                <b>{index + 1}</b><span>{member.isSelf ? "你（已补充）" : member.username}</span><small>{member.requestedSeat != null ? `${member.requestedSeat + 1} 号位` : "排队中"}</small>
              </div>
            ))}
          </div>
          <div className="next-seat-copy">
            <p className="eyebrow">下一局座位确认</p>
            <h2 id="next-seat-title">下一局加入牌桌？</h2>
            <p>你将使用补充的 {formatChips(room.self.pendingRebuy)} 筹码入座，从下一局开始生效。</p>
            <div className="modal-actions">
              <button className="button primary" onClick={confirmSeat}>加入牌桌</button>
              <button className="button secondary" onClick={continueWatching}>继续观战</button>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return null;
}

function SpectatorBar({ room, game, onLeave, onRequestSeat, onWatchPlayer }) {
  const [rulesOpen, setRulesOpen] = useState(false);
  if (room.self.role !== "spectator") return null;
  const focusedUserId = game.spectatorView?.focusUserId;
  const mysteryUserId = game.spectatorView?.mysteryUserId;
  const focusedPlayer = game.players.find((player) => player.userId === focusedUserId);
  return (
    <>
      <div className="spectator-bar">
        <div className="spectator-view-heading">
          <span><Eye size={18} /><span><strong>{focusedPlayer ? `正在观看 ${focusedPlayer.username}` : "观战中"}</strong><small>选择玩家切换手牌视角；神秘玩家始终隐藏</small></span></span>
          <button className="spectator-rule-button" onClick={() => setRulesOpen(true)}><ShieldCheck size={16} /> 观战规则</button>
        </div>
        <div className="spectator-view-switcher" role="listbox" aria-label="切换观战玩家">
          {game.players.map((player) => {
            const member = room.members.find((candidate) => candidate.userId === player.userId);
            const mystery = player.userId === mysteryUserId;
            const focused = player.userId === focusedUserId;
            const retainedAccess = Boolean(player.spectatorHidden && player.spectatorAccessGranted);
            const privateHand = Boolean(player.spectatorHidden && !player.spectatorAccessGranted);
            const disabled = mystery || privateHand || player.folded;
            return (
              <button
                type="button"
                role="option"
                className={`${focused ? "active" : ""} ${mystery ? "mystery" : ""}`.trim()}
                disabled={disabled}
                aria-selected={focused}
                onClick={() => onWatchPlayer(player.userId)}
                key={player.userId}
              >
                <PlayerAvatar name={player.username} tone={member?.avatarTone} />
                <span><strong>{player.username}</strong><small>{mystery ? "神秘玩家 · 手牌隐藏" : privateHand ? "玩家已阻止新的观战" : player.folded ? "已弃牌" : retainedAccess ? "本手已看过 · 权限保留" : focused ? "正在观看" : "查看手牌"}</small></span>
                {mystery || privateHand ? <LockKeyhole size={14} /> : <Eye size={14} />}
              </button>
            );
          })}
        </div>
        <div className="spectator-actions">
          <button className="button compact primary" disabled={room.self.seatRequest} onClick={onRequestSeat}>
            {room.self.seatRequest ? "已申请下一局入座" : "申请下一局入座"}
          </button>
          <button className="button compact ghost" onClick={onLeave}>返回大厅</button>
        </div>
      </div>
      {rulesOpen && (
        <div className="modal-backdrop">
          <section className="modal spectator-rules-modal" role="dialog" aria-modal="true" aria-labelledby="spectator-rules-title">
            <header className="modal-header">
              <div><span className="shield-mark"><ShieldCheck size={25} /></span><h2 id="spectator-rules-title">观战隐私规则</h2></div>
              <button className="icon-button" onClick={() => setRulesOpen(false)} aria-label="关闭观战规则"><X size={20} /></button>
            </header>
            <ul>
              <li>观战者可以切换仍在本局中的玩家，并查看该玩家的实时手牌。</li>
              <li>每局随机指定一位神秘玩家；其手牌由服务器保持隐藏，不能切换查看。</li>
              <li>同一手牌中，一旦观战者成功查看过某位玩家，之后该玩家再隐藏也不会撤销这位观战者已经获得的查看权限。</li>
              <li>玩家弃牌后会退出可观看列表；摊牌时其他手牌正常公开，神秘玩家仍保持隐藏。</li>
            </ul>
            <p className="privacy-note"><ShieldCheck size={18} /> 娱乐筹码仅供好友娱乐，不提供任何形式的现实货币交易。</p>
          </section>
        </div>
      )}
    </>
  );
}

function FoldedSpectatorBar({ game }) {
  const actingPlayer = game.players.find((player) => player.seat === game.actingSeat);
  const focusedPlayer = game.players.find((player) => player.userId === game.spectatorView?.focusUserId);
  return (
    <div className="folded-spectator-bar" role="status" aria-live="polite">
      <span className="folded-spectator-copy">
        <span className="folded-spectator-mark"><Eye size={19} /></span>
        <span>
          <strong>本局已弃牌 · 观战中</strong>
          <small>点击仍在牌局中的玩家座位切换视角；你的原手牌继续保留。</small>
        </span>
      </span>
      <span className="folded-spectator-watch" aria-live="polite">
        {focusedPlayer?.cards?.length ? (
          <>
            <span className="folded-spectator-cards">
              {focusedPlayer.cards.map((card) => <PlayingCard key={card} card={card} small />)}
            </span>
            <span><b>{focusedPlayer.username}</b><small>当前观看</small></span>
          </>
        ) : (
          <><LockKeyhole size={16} /><span><b>请选择玩家</b><small>神秘玩家不可查看</small></span></>
        )}
      </span>
      <span className="folded-spectator-progress">
        <b>{game.stageLabel}</b>
        <small>{actingPlayer ? `等待 ${actingPlayer.username} 行动` : "等待本局结算"}</small>
      </span>
    </div>
  );
}

function HextechDraftScreen({ room, act }) {
  const game = room.game;
  return (
    <section className="table-column game-column hextech-game-column hextech-draft-screen">
      <TableSurface room={room} game={game}>
        <div className="hextech-draft-center">
          <Sparkles size={28} />
          <strong>底牌已发 · 正在装备本手技能</strong>
          <small>公共牌与操作区保持独立；全员完成或倒计时结束后才开放下注。</small>
          <span>底池 {formatChips(game.pot)} · 盲注 {game.smallBlind}/{game.bigBlind}</span>
        </div>
      </TableSurface>
      <div className="hextech-hand-rail" aria-label="自己的手牌轨道">
        <OwnCards room={room} game={game} act={act} />
      </div>
      <HextechEquipmentDraft room={room} act={act} />
    </section>
  );
}

function GameTable({ room, act, onLeave, onChooseSeat }) {
  const game = room.game;
  const isHextech = room.mode === ROOM_MODES.HEXTECH_CHAOS;
  const selfGamePlayer = game.players.find((player) => player.userId === room.self.userId);
  const foldedSpectatorView = room.self.role === "player"
    && game.stage !== "finished"
    && Boolean(selfGamePlayer?.folded);
  const collectingWinnerSeat = game.stage === "finished"
    ? game.players.find((player) => player.userId === game.winners?.[0]?.userId)?.seat ?? null
    : null;
  const initialHoleDealActive = game.stage === "preflop"
    && Date.now() < (game.dealCompleteAt || Date.now() + holeCardDealDurationMs(game.players.length));
  const [dealingLabel, setDealingLabel] = useState(initialHoleDealActive ? "正在环绕发底牌…" : "");
  const [endPhase, setEndPhase] = useState(null);

  useEffect(() => {
    const labels = { preflop: "正在发底牌…", flop: "正在发翻牌…", turn: "正在发转牌…", river: "正在发河牌…" };
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const holeDealRemaining = game.stage === "preflop"
      ? Math.max(0, (game.dealCompleteAt || Date.now() + holeCardDealDurationMs(game.players.length)) - Date.now())
      : 0;
    const label = game.stage === "preflop" && holeDealRemaining > 0
      ? "正在环绕发底牌…"
      : labels[game.stage] ?? "";
    setDealingLabel(label);
    if (!label) return undefined;
    const duration = reducedMotion
      ? 180
      : game.stage === "preflop"
        ? holeDealRemaining
        : 620;
    const timer = window.setTimeout(() => setDealingLabel(""), duration);
    return () => window.clearTimeout(timer);
  }, [game.dealCompleteAt, game.players.length, game.stage, room.handNumber]);

  useEffect(() => setEndPhase(null), [room.handNumber]);
  useEffect(() => {
    if (isHextech && (room.self.role !== "player"
      || room.self.stack !== 0
      || room.self.pendingRebuy > 0
      || !room.self.rebuyDeadline)) {
      setEndPhase(null);
    }
  }, [isHextech, room.self.pendingRebuy, room.self.rebuyDeadline, room.self.role, room.self.stack]);

  function requestSpectatorSeat() {
    if (room.self.everSeated && room.self.stack <= 0 && room.self.pendingRebuy <= 0) {
      setEndPhase("rebuy");
      return;
    }
    onChooseSeat();
  }

  const dealingHoleCards = game.stage === "preflop" && Boolean(dealingLabel);
  const canSwitchWatchPerspective = room.self.role === "spectator" || foldedSpectatorView;

  return (
    <section className={`table-column game-column ${isHextech ? "hextech-game-column" : ""}`}>
      <SpectatorBar
        room={room}
        game={game}
        onLeave={onLeave}
        onRequestSeat={requestSpectatorSeat}
        onWatchPlayer={(userId) => act("game:watch-player", { userId })}
      />
      {isHextech && <HextechMatchStrip room={room} />}
      {foldedSpectatorView && <FoldedSpectatorBar game={game} />}
      <TableSurface room={room} game={game} dealingHoleCards={dealingHoleCards} onWatchPlayer={canSwitchWatchPerspective ? (userId) => act("game:watch-player", { userId }) : null}>
        <div className="pot-display"><span>底池</span><strong>{formatChips(game.pot)}</strong></div>
        <PotChips amount={game.pot} seed={game.handId} collecting={game.stage === "finished"} winnerSeat={collectingWinnerSeat} />
        <DealerDeck visible={dealingHoleCards} />
        <CommunityCards game={game} />
        {game.actingSeat != null && !dealingHoleCards && (
          <span className={`turn-timer-cluster ${game.timeExtension?.used ? "extended" : ""}`}>
            <TurnTimer
              deadline={game.turnDeadline}
              duration={game.actionSeconds + (game.timeExtension?.used ? game.timeExtension.seconds : 0)}
            />
            {game.timeExtension?.used && <small>+{game.timeExtension.seconds}秒</small>}
          </span>
        )}
        <div className={`street-label ${dealingLabel ? "dealing" : ""}`}>{dealingLabel || game.stageLabel}</div>
      </TableSurface>
      <HandTimeline stage={game.stage} />
      {room.self.pendingRebuy > 0 && game.stage !== "finished" && <div className="pending-rebuy"><Check size={18} /> 已补充 {formatChips(room.self.pendingRebuy)}，下一局生效</div>}
      <div className={`game-controls-stage stage-${game.stage}`}>
        <div className="own-cards-slot">
          {room.self.role === "player" && game.stage !== "finished" && !dealingHoleCards && <OwnCards room={room} game={game} act={act} folded={foldedSpectatorView} />}
          {room.self.role === "spectator" && game.stage !== "finished" && !dealingHoleCards && <SpectatorHand game={game} />}
        </div>
        <div className="game-console-slot">
          {isHextech && room.hextech?.participantUserIds?.includes(room.self.userId) && (
            <HextechCharacterControl
              room={room}
              onCommand={(type, commandPayload) => act("hextech:character-command", {
                type,
                ...commandPayload,
              })}
            />
          )}
          {isHextech && room.self.role === "player" && game.stage !== "finished" && !foldedSpectatorView && !dealingLabel && (
            <HextechSkillControl
              room={room}
              onCommand={(command, commandPayload) => {
                if (command === "choice") return Promise.resolve({ localChoice: true });
                const skillWindow = room.hextech?.selfSkillWindow;
                return act("hextech:skill-command", {
                  command,
                  commandId: globalThis.crypto?.randomUUID?.()
                    ?? `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  windowToken: skillWindow?.windowToken ?? skillWindow?.token,
                  windowVersion: skillWindow?.windowVersion ?? skillWindow?.version,
                  ...commandPayload,
                });
              }}
            />
          )}
          {room.self.role === "player" && game.stage !== "finished" && !foldedSpectatorView && !dealingLabel && <ActionBar game={game} bigBlind={game.bigBlind ?? room.settings.bigBlind} act={act} allowTimeExtension={!isHextech} />}
          <ResultCard room={room} game={game} act={act} onRebuy={() => setEndPhase("rebuy")} onSpectate={() => setEndPhase("spectate")} />
        </div>
      </div>
      <EndOfHandFlow room={room} game={game} act={act} phase={endPhase} setPhase={setEndPhase} />
    </section>
  );
}

function SettlementValue({ value, className = "" }) {
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
  return <strong className={`settlement-value ${tone} ${className}`.trim()}>{formatSignedChips(value)}</strong>;
}

function SettlementSidebar({ room, isHost, onRequestFinalize }) {
  const settlement = room.settlement;
  const self = settlement.self;
  const activeHand = Boolean(room.game && room.game.stage !== "finished");
  let finalizeHint = "房主可在两局之间发起终局结算";
  if (settlement.status === "closed") finalizeHint = "终局账本已锁定，所有剩余筹码均已由系统回收";
  else if (activeHand) finalizeHint = "本局结束后才能终局结算";
  else if (settlement.hasPracticeHands) finalizeHint = "本房间含测试玩家，仅作为练习局，不生成好友账单";
  else if (room.handNumber <= 0) finalizeHint = "至少完成一局后才能终局结算";

  return (
    <div className="sidebar-content settlement-sidebar">
      <section className="settlement-rule-card">
        <span className="settlement-rule-icon"><CircleDollarSign size={21} /></span>
        <div><strong>系统托管结算</strong><p>买入记负结算点；每局结束后，在桌筹码最多保留 {formatChips(settlement.tableCap)}，超额部分自动卖出。</p></div>
      </section>

      <section className="settlement-self-card">
        <div className="settlement-section-heading"><span>我的账户</span><small>系统实时记账</small></div>
        <div className="settlement-self-points">
          <span><small>结算点</small><SettlementValue value={self?.settlementPoints ?? 0} /></span>
          <span><small>在桌筹码</small><strong>{formatChips((self?.tableChips ?? 0) + (self?.pendingChips ?? 0))}</strong></span>
          <span><small>{settlement.status === "closed" ? "最终输赢" : activeHand ? "局末预估" : "若现在终局"}</small>{self?.projectedNet == null ? <strong className="settlement-pending">待本局结束</strong> : <SettlementValue value={self.projectedNet} />}</span>
        </div>
      </section>

      <section className="settlement-ledger-card">
        <div className="settlement-section-heading"><span>好友账本</span><small>{settlement.accounts.length} 位玩家</small></div>
        <div className="settlement-account-list">
          {settlement.accounts.map((account) => {
            const member = room.members.find((candidate) => candidate.userId === account.userId);
            return (
              <div className={`settlement-account-row ${account.isSelf ? "self" : ""}`} key={account.userId}>
                <PlayerAvatar name={account.username} tone={member?.avatarTone} />
                <span><strong>{account.username}{account.isSelf ? "（你）" : ""}</strong><small>买入 {formatChips(account.buyIn)} · 在桌 {formatChips(account.tableChips + account.pendingChips)}</small></span>
                <SettlementValue value={account.settlementPoints} />
              </div>
            );
          })}
        </div>
      </section>

      <section className={`settlement-finalize-card ${settlement.hasPracticeHands ? "practice" : ""}`}>
        <p>{finalizeHint}</p>
        {settlement.status === "closed"
          ? <span className="settlement-host-wait">结算完成</span>
          : isHost
          ? <button className="button primary wide" disabled={!settlement.canFinalize} onClick={onRequestFinalize}>终局结算</button>
          : <span className="settlement-host-wait">等待房主发起终局结算</span>}
      </section>
    </div>
  );
}

function FinalSettlementScreen({ room, onLeave }) {
  const settlement = room.settlement;
  const sortedAccounts = [...settlement.accounts].sort((left, right) => (
    right.settlementPoints - left.settlementPoints
    || left.username.localeCompare(right.username, "zh-CN")
  ));
  return (
    <section className="final-settlement-screen">
      <header className="final-settlement-heading">
        <span className="final-settlement-mark"><Check size={30} /></span>
        <div><p className="eyebrow">系统已买回全部筹码</p><h2>本场终局结算</h2><span>{room.handNumber} 局 · {settlement.closedAt ? new Date(settlement.closedAt).toLocaleString("zh-CN", { hour12: false }) : "刚刚完成"}</span></div>
      </header>

      <div className="final-settlement-totals">
        <span><small>累计买入</small><strong>{formatChips(settlement.totals.buyIn)}</strong></span>
        <span><small>系统回收</small><strong>{formatChips(settlement.totals.cashOut)}</strong></span>
        <span><small>系统留存</small><strong>{formatChips(settlement.totals.systemBalance)}</strong></span>
      </div>

      <div className="final-settlement-table" role="table" aria-label="终局输赢账单">
        <div className="final-settlement-row heading" role="row">
          <span>玩家</span><span>总买入</span><span>局后卖出</span><span>离桌 / 终局回收</span><span>最终输赢</span>
        </div>
        {sortedAccounts.map((account, index) => (
          <div className={`final-settlement-row ${account.settlementPoints > 0 ? "winner" : account.settlementPoints < 0 ? "loser" : "even"}`} role="row" key={account.userId}>
            <span className="final-player"><b>{index + 1}</b><span><strong>{account.username}{account.isSelf ? "（你）" : ""}</strong><small>{account.settlementPoints > 0 ? "本场盈利" : account.settlementPoints < 0 ? "本场亏损" : "本场持平"}</small></span></span>
            <span data-label="总买入">{formatChips(account.buyIn)}</span>
            <span data-label="局后卖出">{formatChips(account.autoCashOut)}</span>
            <span data-label="系统回收">{formatChips(account.exitCashOut + account.finalCashOut)}</span>
            <span data-label="最终输赢"><SettlementValue value={account.settlementPoints} /></span>
          </div>
        ))}
      </div>

      {settlement.totals.systemBalance > 0 && <p className="system-balance-note"><ShieldCheck size={17} />系统留存来自加时卡等已消耗筹码，因此玩家输赢合计会相应减少。</p>}
      <footer className="final-settlement-footer"><span>账本已经锁定，不能再开始下一局或补充筹码。</span><button className="button primary" onClick={onLeave}>确认并返回大厅</button></footer>
    </section>
  );
}

function FinalSettlementConfirm({ room, busy, onClose, onConfirm }) {
  const projected = room.settlement.accounts.reduce(
    (total, account) => total + (account.projectedNet ?? account.settlementPoints),
    0,
  );
  return (
    <div className="modal-backdrop final-settlement-backdrop">
      <section className="modal final-settlement-confirm" role="dialog" aria-modal="true" aria-labelledby="final-settlement-title">
        <span className="settlement-confirm-icon"><CircleDollarSign size={28} /></span>
        <p className="eyebrow">不可撤销操作</p>
        <h2 id="final-settlement-title">结束本场并进行终局结算？</h2>
        <ol>
          <li>系统买回每位玩家剩余的在桌与待入座筹码</li>
          <li>合并首次买入、补筹和局后自动卖出记录</li>
          <li>锁定最终输赢，房间不再允许开局</li>
        </ol>
        {projected !== 0 && <p className="settlement-system-preview">当前存在 {formatChips(Math.abs(projected))} 系统筹码差额，通常来自加时卡消耗。</p>}
        <div className="modal-actions">
          <button className="button secondary" disabled={busy} onClick={onClose}>继续游戏</button>
          <button className="button primary" disabled={busy} onClick={onConfirm}>{busy ? "正在结算…" : "确认终局结算"}</button>
        </div>
      </section>
    </div>
  );
}

function RoomSidebar({ room, act, open, onClose, onRequestSettlement }) {
  const [tab, setTab] = useState("players");
  const [message, setMessage] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [kickTarget, setKickTarget] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const messagesRef = useRef(null);
  const stickToLatestRef = useRef(true);
  const isHost = room.hostUserId === room.self.userId;
  const isHextech = room.mode === ROOM_MODES.HEXTECH_CHAOS;
  const currentGamePlayers = useMemo(
    () => new Map((room.game?.players ?? []).map((player) => [player.userId, player])),
    [room.game?.players],
  );
  useEffect(() => {
    if (isHextech && tab === "settlement") setTab("players");
  }, [isHextech, tab]);
  async function send(event) {
    event.preventDefault();
    if (!message.trim()) return;
    stickToLatestRef.current = true;
    await act("chat:send", { text: message });
    setMessage("");
  }

  useEffect(() => {
    if (tab !== "chat" || !stickToLatestRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const messages = messagesRef.current;
      if (messages) messages.scrollTop = messages.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [room.chat.length, tab]);

  function openChat() {
    stickToLatestRef.current = true;
    setTab("chat");
  }
  async function confirmKick() {
    if (!kickTarget) return;
    const result = await act("room:kick", { userId: kickTarget.userId });
    if (result) setKickTarget(null);
  }
  async function confirmHostTransfer() {
    if (!transferTarget) return;
    const result = await act("room:transfer-host", { userId: transferTarget.userId });
    if (result) setTransferTarget(null);
  }
  return (
    <>
    <aside className={`room-sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-mobile-header"><strong>房间信息</strong><button className="icon-button" onClick={onClose} aria-label="关闭侧栏"><X size={20} /></button></div>
      <div className="sidebar-tabs">
        <button className={tab === "players" ? "active" : ""} onClick={() => setTab("players")}><Users size={17} /> 玩家</button>
        <button className={tab === "chat" ? "active" : ""} onClick={openChat}><MessageCircle size={17} /> 聊天</button>
        {!isHextech && <button className={tab === "settlement" ? "active" : ""} onClick={() => setTab("settlement")}><CircleDollarSign size={17} /> 结算</button>}
        <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}><Settings size={17} /> 规则</button>
      </div>
      {tab === "players" && (
        <div className="sidebar-content member-list">
          <p className="list-label">玩家席</p>
          {room.members.filter((member) => member.role === "player").map((member) => {
            const gamePlayer = currentGamePlayers.get(member.userId);
            const foldedWatching = room.game?.stage !== "finished" && gamePlayer?.folded;
            return (
              <div className="member-row" key={member.userId}>
                <PlayerAvatar name={member.username} tone={member.avatarTone} className={foldedWatching ? "spectator" : ""}>{foldedWatching ? <Eye size={15} /> : null}</PlayerAvatar>
                <span><strong>{member.isSelf ? `${member.username}（你）` : member.username}{member.userId === room.hostUserId && <em className="member-host-badge"><Crown size={10} /> 房主</em>}</strong><small>{foldedWatching ? "本局已弃牌 · 观战中" : member.ready ? "已准备" : member.connected ? "未准备" : "已断线"}{member.characterId ? ` · ${hextechCharacter(member.characterId)?.name ?? "海克斯人物"}` : ""}</small>{member.title && <em className="member-title">{member.title}</em>}</span>
                <strong>{formatChips(room.game?.stage === "finished" ? member.stack + member.pendingRebuy : gamePlayer?.stack ?? member.stack)}</strong>
                {isHost && !member.isSelf && !member.isBot && (
                  <span className="member-admin-actions">
                    <button className="member-transfer-button" disabled={!member.connected} onClick={() => { setKickTarget(null); setTransferTarget(member); }} aria-label={`转让房主给 ${member.username}`} title={member.connected ? "转让房主" : "玩家断线时不能转让"}><Crown size={15} /></button>
                    <button className="member-kick-button" disabled={room.game?.stage !== "finished" && Boolean(gamePlayer)} onClick={() => { setTransferTarget(null); setKickTarget(member); }} aria-label={`踢出 ${member.username}`} title={room.game?.stage !== "finished" && gamePlayer ? "牌局结束后可踢出该玩家" : "踢出房间"}><UserMinus size={15} /></button>
                  </span>
                )}
              </div>
            );
          })}
          <p className="list-label">观战席</p>
          {room.members.filter((member) => member.role === "spectator").length === 0
            ? <p className="muted-copy">当前没有观战者</p>
            : room.members.filter((member) => member.role === "spectator").map((member) => (
              <div className="member-row" key={member.userId}>
                <PlayerAvatar name={member.username} tone={member.avatarTone} className="spectator"><Eye size={15} /></PlayerAvatar>
                <span><strong>{member.isSelf ? `${member.username}（你）` : member.username}</strong><small>{member.seatRequest ? `申请下一局入座${member.requestedSeat != null ? ` · ${member.requestedSeat + 1} 号位` : ""}` : "观战中"}</small>{member.title && <em className="member-title">{member.title}</em>}</span>
                {isHost && member.seatRequest && <button className="button compact" onClick={() => act("room:approve-seat", { userId: member.userId })}>允许</button>}
                {isHost && !member.isSelf && <button className="member-kick-button" onClick={() => setKickTarget(member)} aria-label={`踢出 ${member.username}`} title="踢出房间"><UserMinus size={15} /></button>}
              </div>
            ))}
          {room.game && <ActionLog game={room.game} compact />}
        </div>
      )}
      {tab === "chat" && (
        <div className="sidebar-content chat-content">
          <div className="chat-notice">牌局信息显示在牌桌状态栏，不在聊天区刷屏</div>
          <div
            className="messages"
            ref={messagesRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              stickToLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            }}
          >
            {room.chat.filter((item) => !item.system).length === 0 ? <p className="muted-copy">还没有玩家消息</p> : room.chat.filter((item) => !item.system).map((item) => (
              <div key={item.id} className={`message ${item.system ? "system" : ""}`}>
                <strong>{item.username}</strong><p>{item.text}</p>
              </div>
            ))}
          </div>
          <div className="chat-composer">
            {emojiOpen && <div className="emoji-tray" aria-label="颜表情"><button type="button" onClick={() => setMessage((value) => `${value}😀`)}>😀</button><button type="button" onClick={() => setMessage((value) => `${value}😂`)}>😂</button><button type="button" onClick={() => setMessage((value) => `${value}👍`)}>👍</button><button type="button" onClick={() => setMessage((value) => `${value}👏`)}>👏</button><button type="button" onClick={() => setMessage((value) => `${value}😮`)}>😮</button><button type="button" onClick={() => setMessage((value) => `${value}🔥`)}>🔥</button><button type="button" onClick={() => setMessage((value) => `${value}🎉`)}>🎉</button></div>}
            <div className="quick-phrases"><button type="button" onClick={() => setMessage("好牌")}>好牌</button><button type="button" onClick={() => setMessage("加油")}>加油</button><button type="button" onClick={() => setMessage("等你操作")}>等你操作</button><button type="button" onClick={() => setMessage("下一局")}>下一局</button></div>
            <form className="chat-form" onSubmit={send}>
              <button type="button" className="emoji-button" onClick={() => setEmojiOpen((value) => !value)} aria-label="打开颜表情">颜</button>
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入消息" maxLength={200} />
              <button className="icon-button" aria-label="发送"><Send size={19} /></button>
            </form>
          </div>
        </div>
      )}
      {!isHextech && tab === "settlement" && <SettlementSidebar room={room} isHost={isHost} onRequestFinalize={onRequestSettlement} />}
      {tab === "rules" && (
        <div className="sidebar-content rules-list">
          <div><span>初始筹码</span><strong>{formatChips(room.settings.initialChips)}</strong></div>
          {isHextech ? (
            <>
              <div><span>动态目标</span><strong>{formatChips(room.hextech.targetChips)}{room.hextech.targetLocked ? " · 已锁定" : " · 开局锁定"}</strong></div>
              <div><span>手数上限</span><strong>{room.handNumber}/{room.hextech.maxHands}</strong></div>
              <div><span>当前盲注</span><strong>{room.game ? `${room.game.smallBlind} / ${room.game.bigBlind}` : "20 / 40"}</strong></div>
              <div><span>补充筹码</span><strong>归零后补 2,000 × 3</strong></div>
              <div><span>人物</span><strong>整场唯一 · 成长觉醒</strong></div>
              <div><span>公共技能</span><strong>每手 3 选 1 · 60 秒</strong></div>
              <p className="settlement-rule-note"><Sparkles size={18} />30 个公共技能均已接入权威效果层；可在牌局外图鉴完整预习，牌局内按当前可用窗口显示说明。</p>
            </>
          ) : (
            <>
              <div><span>在桌筹码上限</span><strong>{formatChips(room.settlement.tableCap)}</strong></div>
              <div><span>小盲 / 大盲</span><strong>{room.settings.smallBlind} / {room.settings.bigBlind}</strong></div>
              <div><span>人数</span><strong>2–{room.settings.maxPlayers} 人</strong></div>
              <div><span>补充筹码</span><strong>{room.settings.allowRebuy ? `低于 ${formatChips(LOW_STACK_REBUY_THRESHOLD)} 可补 ${formatChips(room.settings.rebuyAmount)} × ${room.settings.maxRebuys}` : "关闭"}</strong></div>
              <div><span>基础思考时间</span><strong>30 秒</strong></div>
              <div><span>加时卡</span><strong>+60 秒 / 500 筹码</strong></div>
              <p className="settlement-rule-note"><CircleDollarSign size={18} />每局结束后，超过上限的筹码由系统自动卖出并记入结算点；终局时再统一买回剩余筹码。</p>
            </>
          )}
          <p className="privacy-note"><ShieldCheck size={18} />观战者可切换查看玩家手牌；每局随机一位神秘玩家由服务器强制隐藏，整局始终不可查看。</p>
        </div>
      )}
    </aside>
    {kickTarget && (
      <div className="kick-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setKickTarget(null); }}>
        <section className="kick-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="kick-confirm-title">
          <span className="kick-confirm-mark"><UserMinus size={22} /></span>
          <div><small>房主管理</small><h2 id="kick-confirm-title">将 {kickTarget.username} 踢出房间？</h2><p>该玩家会立即返回大厅；若已有筹码，将按当前规则记入离场结算。</p></div>
          <div className="modal-actions"><button className="button secondary" onClick={() => setKickTarget(null)}>取消</button><button className="button kick-danger" onClick={confirmKick}>确认踢出</button></div>
        </section>
      </div>
    )}
    {transferTarget && (
      <div className="host-transfer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTransferTarget(null); }}>
        <section className="host-transfer-dialog" role="alertdialog" aria-modal="true" aria-labelledby="host-transfer-title">
          <span className="host-transfer-mark"><Crown size={22} /></span>
          <div><small>房主管理</small><h2 id="host-transfer-title">将房主转让给 {transferTarget.username}？</h2><p>确认后，对方将获得开局、安排座位、踢人和终局结算权限，你将保留普通玩家身份。</p></div>
          <div className="modal-actions"><button className="button secondary" onClick={() => setTransferTarget(null)}>取消</button><button className="button primary" onClick={confirmHostTransfer}>确认转让</button></div>
        </section>
      </div>
    )}
    </>
  );
}

function useRoomVoiceAnnouncements(room, enabled) {
  const stateRef = useRef({
    initialized: false,
    roomCode: null,
    handId: null,
    newestActionKey: "",
  });

  useEffect(() => {
    if (!enabled) cancelVoiceAnnouncements();
  }, [enabled]);

  useEffect(() => () => cancelVoiceAnnouncements(), []);

  useEffect(() => {
    const game = room?.game ?? null;
    const actionLog = Array.isArray(game?.actionLog) ? game.actionLog : [];
    const nextState = {
      initialized: true,
      roomCode: room?.code ?? null,
      handId: game?.handId ?? null,
      newestActionKey: actionLog[0] ? actionLogEntryKey(actionLog[0]) : "",
    };
    const previous = stateRef.current;

    if (!previous.initialized || previous.roomCode !== nextState.roomCode) {
      stateRef.current = nextState;
      return;
    }

    const announcements = [];
    const handStarted = Boolean(nextState.handId && nextState.handId !== previous.handId);
    if (handStarted) {
      announcements.push(...actionLog.slice().reverse().map(actionVoiceAnnouncement).filter(Boolean));
    } else if (nextState.handId && actionLog.length > 0) {
      const previousIndex = previous.newestActionKey
        ? actionLog.findIndex((entry) => actionLogEntryKey(entry) === previous.newestActionKey)
        : actionLog.length;
      if (previousIndex > 0) {
        announcements.push(...actionLog.slice(0, previousIndex).reverse().map(actionVoiceAnnouncement).filter(Boolean));
      }
    }

    stateRef.current = nextState;

    const isClassicRoom = room.mode !== ROOM_MODES.HEXTECH_CHAOS;
    if (!enabled || !isClassicRoom || announcements.length === 0) return;
    announcements.forEach((announcement, index) => {
      speakVoiceAnnouncement(announcement, { interrupt: index === 0 });
    });
  }, [enabled, room]);
}

function RoomScreen({ room, user, socket, onRoom, onLeave, showError, entryMode, onOpenPreferences, onOpenProfile, onOpenSkillLibrary, voiceAnnouncements, onToggleVoiceAnnouncements }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [waitingSpectatorView, setWaitingSpectatorView] = useState(entryMode === "seat-select" ? "seat-select" : "spectator");
  const [settlementConfirmOpen, setSettlementConfirmOpen] = useState(false);
  const [settlementBusy, setSettlementBusy] = useState(false);
  const isHextech = room.mode === ROOM_MODES.HEXTECH_CHAOS;
  const canOpenSkillLibrary = isHextech
    && (!room.game || room.game.stage === "finished")
    && room.hextech?.phase !== "skill-draft";

  useRoomVoiceAnnouncements(room, voiceAnnouncements);

  useEffect(() => {
    setWaitingSpectatorView(entryMode === "seat-select" ? "seat-select" : "spectator");
  }, [entryMode, room.code]);

  const act = useCallback(async (event, payload = {}) => {
    try {
      const result = await emit(socket, event, payload);
      if (result.room) onRoom(result.room);
      return result;
    } catch (error) {
      showError(error.message);
      return null;
    }
  }, [onRoom, showError, socket]);

  async function leave() {
    const result = await act("room:leave");
    if (result) onLeave();
  }

  async function copyCode() {
    await navigator.clipboard.writeText(room.code);
  }

  async function confirmFinalSettlement() {
    setSettlementBusy(true);
    const result = await act("room:final-settlement");
    setSettlementBusy(false);
    if (result) setSettlementConfirmOpen(false);
  }

  const queuedFirstSeat = room.self.role === "spectator" && room.self.seatRequest && room.self.pendingRebuy === 0;
  const activeGame = Boolean(room.game && room.game.stage !== "finished");
  const joinedAfterHand = room.game?.stage === "finished"
    && room.self.role === "player"
    && !room.game.players.some((player) => player.userId === room.self.userId);
  const rejoiningAfterBust = room.game?.stage === "finished"
    && room.self.role === "player"
    && room.self.stack === 0
    && room.self.pendingRebuy > 0;
  const choosingSeat = room.self.role === "spectator"
    && waitingSpectatorView === "seat-select";
  let roomContent;
  if (room.settlement.status === "closed") {
    roomContent = <FinalSettlementScreen room={room} onLeave={leave} />;
  } else if (isHextech && room.hextech?.matchEnd) {
    roomContent = <HextechMatchEnd room={room} onLeave={leave} />;
  } else if (queuedFirstSeat && !activeGame) {
    roomContent = <SeatRequestConfirmation room={room} />;
  } else if (rejoiningAfterBust) {
    roomContent = <RejoinWaiting room={room} act={act} />;
  } else if (joinedAfterHand) {
    roomContent = <WaitingRoom room={room} act={act} />;
  } else if (choosingSeat) {
    roomContent = <SeatSelection room={room} act={act} onContinue={() => setWaitingSpectatorView("spectator")} />;
  } else if (isHextech && room.hextech?.phase === "skill-draft" && room.self.role === "player") {
    roomContent = <HextechDraftScreen room={room} act={act} />;
  } else if (room.game) {
    roomContent = <GameTable room={room} act={act} onLeave={leave} onChooseSeat={() => setWaitingSpectatorView("seat-select")} />;
  } else if (room.self.role === "spectator") {
    roomContent = <SpectatorWaiting room={room} onChooseSeat={() => setWaitingSpectatorView("seat-select")} onLeave={leave} />;
  } else {
    roomContent = <WaitingRoom room={room} act={act} />;
  }

  return (
    <main className="room-shell">
      <RoomHeader room={room} user={user} onLeave={leave} onCopy={copyCode} onToggleSidebar={() => setSidebarOpen(true)} onOpenPreferences={onOpenPreferences} onOpenProfile={onOpenProfile} onOpenSkillLibrary={canOpenSkillLibrary ? onOpenSkillLibrary : null} voiceAnnouncements={voiceAnnouncements} onToggleVoiceAnnouncements={onToggleVoiceAnnouncements} />
      <div className={`room-body ${(((queuedFirstSeat && !activeGame) || choosingSeat || (!room.game && room.self.role === "spectator")) && room.settlement.status !== "closed") ? "entry-mode" : ""} ${room.settlement.status === "closed" ? "settlement-closed" : ""}`}>
        {roomContent}
        <RoomSidebar room={room} act={act} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onRequestSettlement={() => setSettlementConfirmOpen(true)} />
      </div>
      {settlementConfirmOpen && <FinalSettlementConfirm room={room} busy={settlementBusy} onClose={() => setSettlementConfirmOpen(false)} onConfirm={confirmFinalSettlement} />}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [room, setRoom] = useState(null);
  const [roomEntryMode, setRoomEntryMode] = useState("resume");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [displayPreferences, setDisplayPreferences] = useState(initialDisplayPreferences);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [skillLibraryOpen, setSkillLibraryOpen] = useState(false);
  const socketRef = useRef(null);

  const skillLibraryAllowed = !room || (
    room.mode === ROOM_MODES.HEXTECH_CHAOS
    && (!room.game || room.game.stage === "finished")
    && room.hextech?.phase !== "skill-draft"
  );

  useEffect(() => {
    applyDisplayPreferences(displayPreferences);
    try {
      window.localStorage.setItem(DISPLAY_PREFERENCES_KEY, JSON.stringify(displayPreferences));
    } catch {
      // Display settings still work for the current page when storage is unavailable.
    }
  }, [displayPreferences]);

  useEffect(() => {
    if (!skillLibraryAllowed) setSkillLibraryOpen(false);
  }, [skillLibraryAllowed]);

  const updateDisplayPreferences = useCallback((nextPreferences) => {
    setDisplayPreferences((current) => normalizeDisplayPreferences({ ...current, ...nextPreferences }));
  }, []);

  const toggleVoiceAnnouncements = useCallback(() => {
    const enabled = !displayPreferences.voiceAnnouncements;
    if (enabled) speakVoiceAnnouncement("普通牌局行动播报已开启", { interrupt: true });
    else cancelVoiceAnnouncements();
    setDisplayPreferences((current) => normalizeDisplayPreferences({ ...current, voiceAnnouncements: enabled }));
  }, [displayPreferences.voiceAnnouncements]);

  const showError = useCallback((message) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 4200);
  }, []);

  const connect = useCallback((nextUser) => {
    socketRef.current?.disconnect();
    const socket = connectSocket();
    socketRef.current = socket;
    socket.on("room:state", setRoom);
    socket.on("room:kicked", (payload) => {
      setRoom(null);
      setRoomEntryMode("resume");
      showError(typeof payload?.message === "string" ? payload.message : "你已被房主移出房间");
    });
    socket.on("room:expired", (payload) => {
      setRoom(null);
      setRoomEntryMode("resume");
      showError(typeof payload?.message === "string" ? payload.message : "房间已自动解散");
    });
    socket.on("room:ready-reminder", (payload) => {
      showError(typeof payload?.message === "string" ? payload.message : "房主正在等待你准备，请点击“准备”");
    });
    socket.on("room:host-transferred", (payload) => {
      showError(typeof payload?.message === "string" ? payload.message : "房主已转让给你");
    });
    socket.on("connect_error", (error) => showError(error.message));
    socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") showError("与牌桌断开，正在自动重连");
    });
    setUser(nextUser);
  }, [showError]);

  const enterRoom = useCallback((nextRoom, entryMode = "resume") => {
    setRoomEntryMode(entryMode);
    setRoom(nextRoom);
  }, []);

  useEffect(() => {
    api("/api/me")
      .then(({ user: currentUser }) => {
        clearLegacyToken();
        connect(currentUser);
      })
      .catch(() => clearLegacyToken())
      .finally(() => setLoading(false));
    return () => socketRef.current?.disconnect();
  }, [connect]);

  async function logout() {
    try { await api("/api/logout", { method: "POST" }); } catch { /* Local session can still be cleared. */ }
    socketRef.current?.disconnect();
    clearLegacyToken();
    setUser(null);
    setRoom(null);
    setRoomEntryMode("resume");
    setProfileOpen(false);
    setSkillLibraryOpen(false);
  }

  const preferencesPanel = (
    <InterfaceSettings
      open={preferencesOpen}
      preferences={displayPreferences}
      onChange={updateDisplayPreferences}
      onClose={() => setPreferencesOpen(false)}
      onToggleVoiceAnnouncements={toggleVoiceAnnouncements}
    />
  );

  const profilePanel = user ? (
    <PlayerProfilePanel
      open={profileOpen}
      user={user}
      onClose={() => setProfileOpen(false)}
      onSaved={setUser}
      showError={showError}
    />
  ) : null;

  if (loading) return <><div className="loading-screen"><Spade size={32} /><span>正在恢复牌桌…</span></div>{preferencesPanel}</>;
  if (!user) return <><AuthScreen onAuthenticated={connect} onOpenPreferences={() => setPreferencesOpen(true)} /><ErrorNotice message={notice} onClose={() => setNotice("")} />{preferencesPanel}</>;
  if (!socketRef.current) return <><div className="loading-screen"><Spade size={32} /><span>正在连接服务器…</span></div>{preferencesPanel}{profilePanel}</>;

  return (
    <>
      {room
        ? <RoomScreen room={room} user={user} socket={socketRef.current} onRoom={setRoom} onLeave={() => { setRoom(null); setRoomEntryMode("resume"); }} showError={showError} entryMode={roomEntryMode} onOpenPreferences={() => setPreferencesOpen(true)} onOpenProfile={() => setProfileOpen(true)} onOpenSkillLibrary={() => setSkillLibraryOpen(true)} voiceAnnouncements={displayPreferences.voiceAnnouncements} onToggleVoiceAnnouncements={toggleVoiceAnnouncements} />
        : <Lobby user={user} socket={socketRef.current} onLogout={logout} onRoom={enterRoom} showError={showError} onOpenPreferences={() => setPreferencesOpen(true)} onOpenProfile={() => setProfileOpen(true)} onOpenSkillLibrary={() => setSkillLibraryOpen(true)} />}
      <ErrorNotice message={notice} onClose={() => setNotice("")} />
      {preferencesPanel}
      {profilePanel}
      <HextechSkillLibrary open={skillLibraryAllowed && skillLibraryOpen} onClose={() => setSkillLibraryOpen(false)} />
    </>
  );
}
