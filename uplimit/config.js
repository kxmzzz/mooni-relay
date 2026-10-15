/**
 * ค่าตั้งของบอท Uplimit Media ที่รันอยู่ในโปรเซสเดียวกับ relay
 * ตั้งค่าผ่าน Environment ของ Render (ขึ้นต้นด้วย UPLIMIT_)
 */
const path = require('path');

const clean = (value, { digits = false } = {}) => {
  let out = String(value ?? '').trim().replace(/^["']|["']$/g, '').trim();
  out = out.replace(/^Bot\s+/i, '').trim();
  if (digits) {
    const matched = out.match(/\d{5,25}/);
    out = matched ? matched[0] : '';
  }
  return out;
};

module.exports = {
  token: clean(process.env.UPLIMIT_TOKEN, { token: true }),
  guildId: clean(process.env.UPLIMIT_GUILD_ID, { digits: true }),
  welcomeChannelId: clean(process.env.UPLIMIT_WELCOME_CHANNEL_ID, { digits: true }) || null,
  staffRoleId: clean(process.env.UPLIMIT_STAFF_ROLE_ID, { digits: true }) || null,
  ticketCategoryId: clean(process.env.UPLIMIT_TICKET_CATEGORY_ID, { digits: true }) || null,
  logoPath: path.join(__dirname, 'logo.jpg'),
};
