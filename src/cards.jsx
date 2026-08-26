import React from "react";

const SUITS = {
  s: { symbol: "♠", label: "黑桃", red: false },
  h: { symbol: "♥", label: "红桃", red: true },
  d: { symbol: "♦", label: "方块", red: true },
  c: { symbol: "♣", label: "梅花", red: false },
};

export function PlayingCard({ card, hidden = false, small = false, entering = false, className = "", style }) {
  if (hidden || !card) {
    return (
      <div
        className={`playing-card card-back ${small ? "small" : ""} ${entering ? "entering" : ""} ${className}`.trim()}
        style={style}
        aria-label="背面底牌"
      >
        <span className="card-back-mark" />
      </div>
    );
  }
  if (card === "BLANK") {
    return (
      <div
        className={`playing-card card-blank ${small ? "small" : ""} ${entering ? "entering" : ""} ${className}`.trim()}
        style={style}
        aria-label="白板牌，没有点数与花色"
      >
        <span className="card-rank">?</span>
        <span className="card-suit">✦</span>
      </div>
    );
  }
  const rank = card.slice(0, -1).replace("T", "10");
  const suit = SUITS[card.at(-1)];
  return (
    <div
      className={`playing-card ${suit.red ? "red" : ""} ${small ? "small" : ""} ${entering ? "entering" : ""} ${className}`.trim()}
      style={style}
      aria-label={`${suit.label}${rank}`}
    >
      <span className="card-rank">{rank}</span>
      <span className="card-suit">{suit.symbol}</span>
    </div>
  );
}

export function EmptyCard({ small = false }) {
  return <div className={`playing-card card-empty ${small ? "small" : ""}`} aria-hidden="true" />;
}
