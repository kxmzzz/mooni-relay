/**
 * ฟังการเปลี่ยนยศแบบเรียลไทม์ (Discord gateway) — ให้/ถอดยศในดิสแล้วแอปรู้ภายในไม่กี่วินาที
 *
 * ใช้บอท Mooni ตัวเดิม (DISCORD_BOT_TOKEN) ฟัง GuildMemberUpdate / GuildMemberRemove ในดิสหลักและดิสที่สอง
 * ยศของใครเปลี่ยน → ล้างแคชยศของคนนั้น → ส่ง { type: 'auth:changed', uid } ให้แอปทุกเครื่องที่ต่ออยู่
 * แอปเครื่องที่ล็อกอินด้วย uid นั้นจะเช็คยศใหม่ทันที (เครื่องอื่นไม่สนใจ)
 * ต่อ gateway ไม่ได้ (บอทไม่มี Server Members Intent / เน็ตมีปัญหา) → ยังเหลือการเช็คเป็นรอบ ๆ เหมือนเดิม
 */
const { Client, Events, GatewayIntentBits } = require('discord.js');

const state = { enabled: false, online: false, error: null, events: 0 };

function startRoleWatch({ token, guildIds, onChange }) {
  if (!token) { state.error = 'no-token'; return state; }
  const watched = new Set(guildIds.filter(Boolean));
  state.enabled = true;

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const fire = (guildId, uid, why) => {
    if (!watched.has(guildId) || !uid) return;
    state.events++;
    try { onChange(uid, why); } catch (err) { console.error('[role-watch] onChange:', err.message); }
  };

  client.once(Events.ClientReady, (c) => {
    state.online = true;
    state.error = null;
    console.log(`[role-watch] ฟังการเปลี่ยนยศแบบสดแล้ว (${c.user.tag}) · ${c.guilds.cache.filter((g) => watched.has(g.id)).map((g) => g.name).join(', ')}`);
  });
  client.on(Events.GuildMemberUpdate, (before, after) => {
    // before อาจเป็น partial (ไม่รู้ยศเดิม) — ถือว่าเปลี่ยนไว้ก่อน ให้แอปเช็คใหม่ไม่เสียหาย
    const a = [...after.roles.cache.keys()].sort().join(',');
    const b = before.partial ? null : [...before.roles.cache.keys()].sort().join(',');
    if (a !== b) fire(after.guild.id, after.id, 'roles');
  });
  client.on(Events.GuildMemberRemove, (m) => fire(m.guild.id, m.id, 'left'));
  client.on(Events.ShardDisconnect, () => { state.online = false; });
  client.on(Events.ShardResume, () => { state.online = true; });
  client.on(Events.Error, (err) => { state.error = err.message; console.error('[role-watch] error:', err.message); });

  client.login(token).catch((err) => {
    state.online = false;
    state.error = err?.code === 'DisallowedIntents' ? 'ต้องเปิด SERVER MEMBERS INTENT ของบอท Mooni' : String(err?.message || err);
    console.error('[role-watch] ล็อกอินไม่สำเร็จ:', state.error);
  });
  return state;
}

const roleWatchStatus = () => ({ ...state });

module.exports = { startRoleWatch, roleWatchStatus };
