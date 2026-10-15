const config = require('./config');
const { getMessages } = require('./store');
const { buildMessage, countMembers } = require('./render');

/** ส่งข้อความต้อนรับเมื่อมีสมาชิกใหม่เข้าเซิร์ฟเวอร์ (ใช้ข้อความจากแดชบอร์ด) */
async function sendWelcome(member) {
  const channel = config.welcomeChannelId
    ? member.guild.channels.cache.get(config.welcomeChannelId)
    : null;

  if (!channel || !channel.isTextBased()) {
    console.warn(
      `⚠️ ไม่พบห้องต้อนรับ (WELCOME_CHANNEL_ID=${config.welcomeChannelId || 'ไม่ได้ตั้งค่า'}) — ข้ามการส่งข้อความต้อนรับ`,
    );
    return;
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
    console.log(`👋 ต้อนรับ ${member.user.tag} แล้ว`);
  } catch (err) {
    console.error('❌ ส่งข้อความต้อนรับไม่สำเร็จ:', err);
  }
}

module.exports = { sendWelcome };
