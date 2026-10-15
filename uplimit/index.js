/**
 * บอท Uplimit Media — รันอยู่ในโปรเซสเดียวกับ relay
 *
 * ย้ายมาจากโปรเจกต์ uplimit-media-bot (บอทแบบ gateway) เพราะโฮสต์ที่รัน 24 ชั่วโมงมีอยู่แล้วที่นี่
 * ทำงานเหมือนเดิม: ต้อนรับสมาชิกใหม่ · คำสั่ง /ticketpanel · ปุ่มเปิด/ปิดตั๋ว
 * ถ้าไม่ได้ตั้ง UPLIMIT_TOKEN จะปิดตัวเองเงียบ ๆ (relay ทำงานตามปกติ)
 */
const { Client, Events, GatewayIntentBits, Partials, MessageFlags } = require('discord.js');
const config = require('./config');
const { sendWelcome } = require('./welcome');
const { panelCommand, handlePanelCommand, handleTicketButton } = require('./ticket');

let client = null;
const state = { enabled: false, online: false, tag: null, guild: null, error: null };

async function startUplimit() {
  if (!config.token || !config.guildId) {
    state.error = 'no-token';
    console.log('[uplimit] ปิด — ยังไม่ได้ตั้ง UPLIMIT_TOKEN / UPLIMIT_GUILD_ID');
    return state;
  }

  state.enabled = true;
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    state.online = true;
    state.tag = readyClient.user.tag;
    state.guild = readyClient.guilds.cache.map((g) => g.name).join(', ');
    console.log(`[uplimit] บอท ${readyClient.user.tag} ออนไลน์ · เซิร์ฟเวอร์: ${state.guild}`);

    // ลงทะเบียนคำสั่งเฉพาะเซิร์ฟเวอร์ (ใช้ได้ทันที ไม่ต้องรอ Discord กระจายคำสั่ง)
    try {
      await readyClient.application.commands.set([panelCommand.toJSON()], config.guildId);
      console.log('[uplimit] ลงทะเบียนคำสั่ง /ticketpanel แล้ว');
    } catch (err) {
      console.error('[uplimit] ลงทะเบียนคำสั่งไม่สำเร็จ:', err.message);
    }
  });

  client.on(Events.GuildMemberAdd, (member) => {
    sendWelcome(member).catch((err) => console.error('[uplimit] ต้อนรับผิดพลาด:', err.message));
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'ticketpanel') await handlePanelCommand(interaction);
        return;
      }
      if (interaction.isButton() && interaction.customId.startsWith('ticket_')) {
        await handleTicketButton(interaction);
      }
    } catch (err) {
      console.error('[uplimit] จัดการ interaction ไม่สำเร็จ:', err);
      const message = '❌ เกิดข้อผิดพลาด ลองอีกครั้งภายหลัง';
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      } catch {
        /* ตอบกลับไม่ได้ — ไม่เป็นไร */
      }
    }
  });

  client.on(Events.Error, (err) => console.error('[uplimit] client error:', err.message));

  try {
    await client.login(config.token);
  } catch (err) {
    state.online = false;
    state.error = String(err?.code || err?.message || err);
    const hint =
      err?.code === 'DisallowedIntents'
        ? 'ยังไม่เปิด SERVER MEMBERS INTENT ที่หน้า Bot ของแอป Uplimit'
        : err?.message || err;
    console.error('[uplimit] ล็อกอินไม่สำเร็จ:', hint);
  }

  return state;
}

/** สถานะสำหรับแสดงใน /health (ไม่มีข้อมูลลับ) */
const status = () => ({ ...state });

module.exports = { startUplimit, status };
