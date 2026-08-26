const frame = document.querySelector('.app-frame');
const screenSelect = document.querySelector('#screenSelect');
const zoneButton = document.querySelector('#toggleZones');
let equippedSkill = '透视眼';

const skillBehavior = {
  '透视眼': { art: '眼', kind: 'player', state: '可发动', help: '点击牌桌上带有金色指针的玩家。公共牌和手牌保持可见。' },
  '我是赌圣': { art: '赌', kind: 'self', state: '可发动', help: '选择手牌轨道中的一张底牌，再进入目标点数选择。' },
  '技能护盾': { art: '盾', kind: 'passive', state: '被动生效中', help: '被动技能不需要手动选择目标。' },
};

function setScreen(screen) {
  frame.dataset.screen = screen;
  screenSelect.value = screen;
}

screenSelect.addEventListener('change', (event) => setScreen(event.target.value));

document.querySelectorAll('[data-device]').forEach((button) => {
  if (!button.closest('.segmented')) return;
  button.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    frame.dataset.device = button.dataset.device;
    if (button.dataset.frameWidth) {
      frame.style.setProperty('--preview-width', `${button.dataset.frameWidth}px`);
      frame.style.setProperty('--preview-height', `${button.dataset.frameHeight}px`);
    } else {
      frame.style.removeProperty('--preview-width');
      frame.style.removeProperty('--preview-height');
    }
  });
});

zoneButton.addEventListener('click', () => {
  frame.classList.toggle('zones-visible');
  zoneButton.textContent = frame.classList.contains('zones-visible') ? '隐藏安全区' : '显示安全区';
});

document.querySelectorAll('.character-card:not(:disabled)').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.character-card').forEach((item) => item.classList.remove('selected'));
    card.classList.add('selected');
    document.querySelector('#characterName').textContent = card.dataset.character;
    document.querySelector('#characterDetail').textContent = card.dataset.detail;
    document.querySelector('#lockCharacter').textContent = `选择${card.dataset.character}`;
  });
});

document.querySelector('#lockCharacter').addEventListener('click', (event) => {
  event.currentTarget.textContent = '已锁定人物';
  window.setTimeout(() => setScreen('draft'), 320);
});

document.querySelectorAll('.skill-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.skill-card').forEach((item) => item.classList.remove('selected'));
    card.classList.add('selected');
    document.querySelector('#equipSkill').textContent = `装备${card.dataset.skill}`;
  });
});

document.querySelector('#equipSkill').addEventListener('click', () => {
  const selected = document.querySelector('.skill-card.selected');
  equippedSkill = selected?.dataset.skill || '透视眼';
  const behavior = skillBehavior[equippedSkill] || { art: equippedSkill.slice(0, 1), kind: 'player', state: '可发动', help: '请选择一名有效目标。' };
  document.querySelector('#useSkill > span').textContent = behavior.art;
  document.querySelector('#useSkill strong').textContent = equippedSkill;
  document.querySelector('#skillState').textContent = behavior.state;
  document.querySelector('#useSkill').disabled = behavior.kind === 'passive';
  setScreen('play');
});
document.querySelector('#useSkill').addEventListener('click', () => {
  const behavior = skillBehavior[equippedSkill] || { kind: 'player', help: '请选择一名有效目标。' };
  frame.dataset.targetKind = behavior.kind;
  document.querySelector('#targetSkillName').textContent = equippedSkill;
  document.querySelector('#targetSkillHelp').textContent = behavior.help;
  frame.querySelector('[data-event="target"]').textContent = behavior.kind === 'self'
    ? `${equippedSkill}：请选择自己的一张底牌`
    : `${equippedSkill}：请选择一名有效目标`;
  setScreen('target');
});
document.querySelector('#cancelTarget').addEventListener('click', () => setScreen('play'));

document.querySelectorAll('.seat[data-valid-target="true"]').forEach((seat) => {
  seat.addEventListener('click', () => {
    if (frame.dataset.screen !== 'target' || frame.dataset.targetKind !== 'player') return;
    const name = seat.querySelector('strong').textContent;
    frame.querySelector('[data-event="play"]').textContent = `已对${name}发动${equippedSkill}`;
    setScreen('play');
  });
});

document.querySelectorAll('.hole-cards .playing-card').forEach((card) => {
  card.addEventListener('click', () => {
    if (frame.dataset.screen !== 'target' || frame.dataset.targetKind !== 'self') return;
    frame.querySelector('[data-event="play"]').textContent = `${equippedSkill}已选择底牌 ${card.innerText.trim().replace(/\s+/g, '')}`;
    setScreen('play');
  });
});

document.querySelector('#rerollSkills').addEventListener('click', (event) => {
  event.currentTarget.textContent = '已刷新';
  event.currentTarget.disabled = true;
  const cards = [...document.querySelectorAll('.skill-card')];
  cards.forEach((card, index) => {
    const names = ['技能护盾', '悬赏令', '沉默是金'];
    card.dataset.skill = names[index];
    card.querySelector('strong').textContent = names[index];
  });
  cards[0].click();
});
