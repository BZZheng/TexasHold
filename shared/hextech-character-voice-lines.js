function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const HEXTECH_CHARACTER_VOICE_EVENTS = Object.freeze({
  SELECT: "select",
  ACTIVATE: "activate",
  PROGRESS: "progress",
  AWAKEN: "awaken",
});

export const HEXTECH_CHARACTER_VOICE_LINES = deepFreeze({
  fenxiang: {
    select: "别看我筹码少，赢你刚刚好。",
    activate: "小筹码，也能掀翻大底池。",
    progress: "越压我，回报越甜。",
    awaken: "现在，轮到小筹码坐庄了。",
  },
  xu: {
    select: "别急，火候到了我自然出手。",
    activate: "下一街，给全桌加点炭火。",
    progress: "最后两秒，才是最香的火候。",
    awaken: "炭火正旺，这桌我来掌勺。",
  },
  jiansheng: {
    select: "牌还没亮，气势先到。",
    activate: "剑压落下，你这一手别想抬高。",
    progress: "敢加？先问过我的剑。",
    awaken: "一剑镇全桌。",
  },
  ya: {
    select: "顺流太没意思，我偏要逆着来。",
    activate: "这张河牌，不合我的意。",
    progress: "先把自己推上浪尖。",
    awaken: "风浪越大，我越先到河口。",
  },
  qiwan: {
    select: "灵感不等牌，牌得追上灵感。",
    activate: "左边还是右边？交给下一张。",
    progress: "这一张，正好接上我的奇想。",
    awaken: "灵感回响，再来一次好点子。",
  },
  zige: {
    select: "牌桌之外，还有资金的玩法。",
    activate: "这笔钱可以借，利息得算清。",
    progress: "本金回来了，利息也别忘了。",
    awaken: "让筹码替我继续赚钱。",
  },
  mao: {
    select: "花色这种事，信我就对了。",
    activate: "下一张，我说什么花色，就是什么花色。",
    progress: "质疑可以，先准备好看真牌。",
    awaken: "四种花色，都听我的蛊惑。",
  },
  wengwengwen: {
    select: "月亮升起来，破绽也就亮了。",
    activate: "月痕锁定——别眨眼。",
    progress: "听见了吗？刀刃在嗡嗡作响。",
    awaken: "满月已至，双刃归巢。",
  },
});

export function validateHextechCharacterVoiceLines(characterIds = Object.keys(HEXTECH_CHARACTER_VOICE_LINES)) {
  const requiredEvents = Object.values(HEXTECH_CHARACTER_VOICE_EVENTS);
  const errors = [];
  for (const characterId of characterIds) {
    const lines = HEXTECH_CHARACTER_VOICE_LINES[characterId];
    if (!lines) {
      errors.push(`${characterId} 缺少人物台词`);
      continue;
    }
    for (const event of requiredEvents) {
      if (typeof lines[event] !== "string" || !lines[event].trim()) {
        errors.push(`${characterId}.${event} 必须是非空台词`);
      }
    }
  }
  return errors;
}

export function assertValidHextechCharacterVoiceLines(characterIds) {
  const errors = validateHextechCharacterVoiceLines(characterIds);
  if (errors.length) throw new Error(errors.join("；"));
  return true;
}
