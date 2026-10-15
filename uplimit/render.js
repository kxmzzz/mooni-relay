const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

const PROJECT_ROOT = __dirname;   // รูป/โลโก้อยู่ใน uplimit/ เอง

/** ข้อมูลตัวอย่างสำหรับพรีวิว/ทดสอบ */
const SAMPLE_CONTEXT = {
  userId: null,
  username: 'ตัวอย่างสมาชิก',
  count: 87,
  serverName: 'Uplimit Media',
  avatarURL: null,
};

function toColor(value, fallback = 0x5865f2) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.trim().match(/^#?([0-9a-f]{6})$/i);
    if (match) return parseInt(match[1], 16);
  }
  return fallback;
}

/** แทนที่ {user} {username} {count} {server} ในข้อความ */
function applyPlaceholders(text, ctx = {}) {
  const c = { ...SAMPLE_CONTEXT, ...ctx };
  return String(text ?? '')
    .replaceAll('{user}', c.userId ? `<@${c.userId}>` : `@${c.username}`)
    .replaceAll('{username}', c.username)
    .replaceAll('{count}', String(c.count))
    .replaceAll('{server}', c.serverName);
}

/** เปลี่ยนค่ารูปภาพ (URL / ไฟล์ในโปรเจกต์) เป็นรูปที่แนบใน embed ได้ */
function resolveImage(image) {
  if (!image) return { imageUrl: null, files: [] };
  if (/^https?:\/\//i.test(image)) return { imageUrl: image, files: [] };

  const abs = path.resolve(PROJECT_ROOT, image);
  if (
    !abs.startsWith(PROJECT_ROOT) ||
    !fs.existsSync(abs) ||
    !fs.statSync(abs).isFile()
  ) {
    return { imageUrl: null, files: [] };
  }
  const name = path.basename(abs);
  return {
    imageUrl: `attachment://${name}`,
    files: [new AttachmentBuilder(abs, { name })],
  };
}

/** สร้าง embed + ไฟล์แนบจาก config ข้อความ */
function buildMessage(cfg = {}, ctx = {}) {
  const embed = new EmbedBuilder().setColor(toColor(cfg.color));
  if (cfg.title) embed.setTitle(applyPlaceholders(cfg.title, ctx).slice(0, 256));
  if (cfg.description) {
    embed.setDescription(applyPlaceholders(cfg.description, ctx).slice(0, 4096));
  }

  const { imageUrl, files } = resolveImage(cfg.image);
  if (imageUrl) embed.setImage(imageUrl);
  if (cfg.useAvatar && ctx.avatarURL) embed.setThumbnail(ctx.avatarURL);
  embed.setTimestamp();

  return { embed, files };
}

/** นับจำนวนสมาชิก (ใช้แคชถ้าครบทั้งเซิร์ฟ ไม่งั้นใช้ memberCount ของเซิร์ฟเวอร์) */
function countMembers(guild) {
  if (!guild) return 0;
  const cache = guild.members?.cache;
  const total = guild.memberCount ?? 0;
  if (cache?.size && cache.size >= total) {
    return cache.filter((m) => !m.user.bot).size;
  }
  return total;
}

module.exports = {
  buildMessage,
  applyPlaceholders,
  resolveImage,
  toColor,
  countMembers,
  SAMPLE_CONTEXT,
};
