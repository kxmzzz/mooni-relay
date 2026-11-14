const { PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { getMessages } = require('./store');
const { buildMessage, countMembers } = require('./render');

/** สิทธิ์ที่บอทต้องมีในห้องต้อนรับ (แนบโลโก้เป็นไฟล์ จึงต้องมี AttachFiles ด้วย) */
const NEEDED_PERMS = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['AttachFiles', PermissionFlagsBits.AttachFiles],
];

/**
 * สถานะระบบต้อนรับ — โชว์ใน /health (ไม่มีข้อมูลลับ)
 * เดิมถ้าหาห้องไม่เจอ/ส่งไม่ผ่าน จะมีแค่บรรทัดใน log ของ Render ทำให้ "บอทออนไลน์แต่ไม่ต้อนรับ" แล้วไม่มีใครเห็นสาเหตุ
 */
const welcomeState = {
  configuredChannelId: config.welcomeChannelId,
  channelId: null,
  channelName: null,
  source: null,          // 'configured' = ห้องที่ตั้งใน UPLIMIT_WELCOME_CHANNEL_ID · 'system' = ห้องระบบของเซิร์ฟเวอร์ (สำรอง)
  missingPerms: [],
  problem: null,
  checkedAt: null,
  lastJoin: null,        // { at, user }
  lastSent: null,        // { at, user }
  lastError: null,       // { at, user, error }
};

/**
 * หาห้องต้อนรับ: ห้องที่ตั้งไว้ → ถ้าไม่อยู่ในแคชให้ดึงจาก Discord → ถ้ายังไม่เจอใช้ห้องระบบของเซิร์ฟเวอร์
 * คืน { channel, source, missingPerms, problem }
 */
async function resolveWelcomeChannel(guild, channelId = config.welcomeChannelId) {
  let channel = null;
  let source = null;
  let problem = null;

  if (channelId) {
    channel = guild.channels.cache.get(channelId) || null;
    if (!channel) {
      channel = await guild.channels.fetch(channelId).catch(() => null);
    }
    if (channel) source = 'configured';
    else problem = `ไม่พบห้อง UPLIMIT_WELCOME_CHANNEL_ID=${channelId} ในเซิร์ฟเวอร์ (ถูกลบ/ID ผิด/บอทมองไม่เห็น)`;
  } else {
    problem = 'ไม่ได้ตั้ง UPLIMIT_WELCOME_CHANNEL_ID';
  }

  if (channel && !channel.isTextBased?.()) {
    problem = `ห้อง ${channelId} ไม่ใช่ห้องข้อความ`;
    channel = null;
    source = null;
  }

  if (!channel && guild.systemChannel) {
    channel = guild.systemChannel;
    source = 'system';
  }

  let missingPerms = [];
  const me = guild.members?.me;
  if (channel && me && typeof channel.permissionsFor === 'function') {
    const perms = channel.permissionsFor(me);
    if (perms) missingPerms = NEEDED_PERMS.filter(([, bit]) => !perms.has(bit)).map(([name]) => name);
  }

  return { channel, source, missingPerms, problem };
}

/** ตรวจห้องต้อนรับแล้วอัปเดตสถานะ (เรียกตอนบอทออนไลน์ และทุกครั้งที่มีคนเข้า) */
async function checkWelcome(guild) {
  const r = await resolveWelcomeChannel(guild);
  Object.assign(welcomeState, {
    configuredChannelId: config.welcomeChannelId,
    channelId: r.channel?.id || null,
    channelName: r.channel?.name || null,
    source: r.source,
    missingPerms: r.missingPerms,
    problem: r.problem,
    checkedAt: new Date().toISOString(),
  });

  if (!r.channel) {
    console.warn(`[uplimit] ⚠️ ระบบต้อนรับใช้ไม่ได้: ${r.problem || 'ไม่พบห้อง'} และเซิร์ฟเวอร์ไม่มีห้องระบบให้ใช้แทน`);
  } else {
    if (r.source === 'system') {
      console.warn(`[uplimit] ⚠️ ${r.problem} — ใช้ห้องระบบ #${r.channel.name} แทน`);
    }
    if (r.missingPerms.length) {
      console.warn(`[uplimit] ⚠️ บอทขาดสิทธิ์ในห้องต้อนรับ #${r.channel.name}: ${r.missingPerms.join(', ')}`);
    }
  }
  return r;
}

/** ส่งข้อความต้อนรับเมื่อมีสมาชิกใหม่เข้าเซิร์ฟเวอร์ (ใช้ข้อความจาก uplimit/data/messages.json) */
async function sendWelcome(member) {
  const now = () => new Date().toISOString();
  const who = member.user?.tag || member.user?.username || member.id;
  welcomeState.lastJoin = { at: now(), user: who };

  const { channel } = await checkWelcome(member.guild);
  if (!channel) {
    welcomeState.lastError = { at: now(), user: who, error: welcomeState.problem || 'ไม่พบห้องต้อนรับ' };
    return false;
  }

  const cfg = getMessages().welcome;
  const ctx = {
    userId: member.id,
    username: member.user.username,
    count: countMembers(member.guild),
    serverName: member.guild.name,
    avatarURL: member.displayAvatarURL({ extension: 'png', size: 256 }),
  };

  const { embed, files } = buildMessage(cfg, ctx);

  try {
    await channel.send({ embeds: [embed], files });
    welcomeState.lastSent = { at: now(), user: who };
    console.log(`[uplimit] 👋 ต้อนรับ ${who} ใน #${channel.name} แล้ว`);
    return true;
  } catch (err) {
    const error = `${err?.code ? err.code + ' ' : ''}${err?.message || err}`;
    welcomeState.lastError = { at: now(), user: who, error };
    console.error(`[uplimit] ❌ ส่งข้อความต้อนรับ ${who} ใน #${channel.name} ไม่สำเร็จ: ${error}`);
    return false;
  }
}

const welcomeStatus = () => ({ ...welcomeState, missingPerms: [...welcomeState.missingPerms] });

module.exports = { sendWelcome, checkWelcome, resolveWelcomeChannel, welcomeStatus };
