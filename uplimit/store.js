const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');

/** ปุ่มเริ่มต้นของแผง Ticket (2 ปุ่ม — เพิ่มได้ถึง 3 จากแดชบอร์ด) */
const DEFAULT_TICKET_BUTTONS = [
  { label: 'สร้างห้องตั๋ว', emoji: '🎫', style: 'primary', action: 'create', url: '', ticketName: '' },
  { label: 'ปิดตั๋ว', emoji: '🔒', style: 'danger', action: 'close', url: '', ticketName: '' },
];

/** ค่าเริ่มต้นของข้อความทั้งหมด */
const DEFAULT_MESSAGES = {
  welcome: {
    title: 'ยินดีต้อนรับ Uplimit Media',
    description: [
      'สวัสดี {user} 🎉',
      'ขอต้อนรับเข้าสู่คอมมูนิตี้ของเรา',
      'มีอะไรถามได้เลยครับ',
      '',
      'คุณคือสมาชิกคนที่ **{count}** ของเซิร์ฟเวอร์',
    ].join('\n'),
    color: '#5865f2',
    image: 'logo.jpg',
    useAvatar: true,
  },
  ticket: {
    title: 'Ticket สำหรับติดต่อทีมงาน',
    description: 'กดปุ่มด้านล่างเพื่อเปิดตั๋วและติดต่อทีมงาน',
    color: '#5865f2',
    image: 'logo.jpg',
    buttons: DEFAULT_TICKET_BUTTONS,
  },
};

const BUTTON_ACTIONS = new Set(['create', 'close', 'link']);

/** แปลงปุ่มเป็นรูปแบบ array เสมอ (รองรับข้อมูลเก่าที่เป็น {create, close}) */
function normalizeButtons(buttons) {
  if (Array.isArray(buttons) && buttons.length) {
    return buttons.slice(0, 3).map((btn) => ({
      label: String(btn?.label ?? '').slice(0, 80),
      emoji: String(btn?.emoji ?? '').slice(0, 32),
      style: String(btn?.style ?? 'primary'),
      action: BUTTON_ACTIONS.has(btn?.action) ? btn.action : 'create',
      url: String(btn?.url ?? '').slice(0, 500),
      // ชื่อห้องตั๋วเมื่อกดปุ่มนี้ (ต่อท้ายชื่อผู้ใช้ เช่น kxmzzz-สนใจเข้าสังกัด)
      ticketName: String(btn?.ticketName ?? '').slice(0, 50),
    }));
  }

  if (buttons && typeof buttons === 'object') {
    const migrated = [];
    if (buttons.create) {
      migrated.push({
        label: String(buttons.create.label ?? 'สร้างห้องตั๋ว'),
        emoji: String(buttons.create.emoji ?? ''),
        style: String(buttons.create.style ?? 'primary'),
        action: 'create',
        url: '',
      });
    }
    if (buttons.close) {
      migrated.push({
        label: String(buttons.close.label ?? 'ปิดตั๋ว'),
        emoji: String(buttons.close.emoji ?? ''),
        style: String(buttons.close.style ?? 'danger'),
        action: 'close',
        url: '',
      });
    }
    if (migrated.length) return migrated;
  }

  return structuredClone(DEFAULT_TICKET_BUTTONS);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** อ่านข้อความปัจจุบัน (รวมกับค่าเริ่มต้นเผื่อไฟล์ไม่ครบ) */
function getMessages() {
  let merged;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    merged = deepMerge(DEFAULT_MESSAGES, JSON.parse(raw));
  } catch {
    merged = structuredClone(DEFAULT_MESSAGES);
  }
  merged.ticket.buttons = normalizeButtons(merged.ticket.buttons);
  return merged;
}

/** บันทึกข้อความ (รับเฉพาะส่วนที่ต้องการเปลี่ยน) */
function saveMessages(partial) {
  const next = deepMerge(getMessages(), partial);
  next.ticket.buttons = normalizeButtons(next.ticket.buttons);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { getMessages, saveMessages, DEFAULT_MESSAGES, DEFAULT_TICKET_BUTTONS };
