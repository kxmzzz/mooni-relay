const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  InteractionContextType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const config = require('./config');
const { getMessages } = require('./store');
const { buildMessage } = require('./render');

const OWNER_TAG = 'ticket-owner:';

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** คำสั่ง /ticketpanel — ส่งแผงปุ่ม Ticket */
const panelCommand = new SlashCommandBuilder()
  .setName('ticketpanel')
  .setDescription('ส่งแผงปุ่ม Ticket สำหรับติดต่อทีมงาน')
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('ห้องที่จะส่งแผง Ticket (ไม่ใส่ = ห้องปัจจุบัน)')
      .addChannelTypes(ChannelType.GuildText),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

/** อ่าน ID เจ้าของตั๋วจาก topic ของห้อง */
function parseOwnerId(channel) {
  const match = (channel.topic || '').match(/ticket-owner:(\d+)/);
  return match ? match[1] : null;
}

/** สร้างปุ่มจากค่าที่ตั้งไว้ในแดชบอร์ด */
function buildButton(spec, customId, fallbackLabel, fallbackStyle) {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(String(spec?.label || fallbackLabel).slice(0, 80))
    .setStyle(BUTTON_STYLES[spec?.style] ?? fallbackStyle);

  if (spec?.emoji) {
    try {
      button.setEmoji(String(spec.emoji).slice(0, 32));
    } catch {
      /* ข้ามอิโมจิที่ไม่ถูกต้อง */
    }
  }
  return button;
}

/** ปุ่มลิงก์ (เปิดเว็บ) */
function buildLinkButton(spec) {
  const button = new ButtonBuilder()
    .setLabel(String(spec?.label || 'ลิงก์').slice(0, 80))
    .setStyle(ButtonStyle.Link)
    .setURL(spec.url);

  if (spec?.emoji) {
    try {
      button.setEmoji(String(spec.emoji).slice(0, 32));
    } catch {
      /* ข้ามอิโมจิที่ไม่ถูกต้อง */
    }
  }
  return button;
}

/** หาปุ่ม "ปิดตั๋ว" ที่ตั้งไว้ (ถ้าไม่มีใช้ค่าเริ่มต้น) */
function findCloseSpec(buttons) {
  return (
    buttons?.find((btn) => btn.action === 'close') ?? {
      label: 'ปิดตั๋ว',
      emoji: '🔒',
      style: 'danger',
      action: 'close',
      url: '',
    }
  );
}

/** แถวปุ่มของแผง Ticket (2-3 ปุ่มตามที่ตั้งไว้ในแดชบอร์ด) */
function buildPanelRow(buttons) {
  const specs = (Array.isArray(buttons) ? buttons : []).slice(0, 3);
  const row = new ActionRowBuilder();

  // หมายเหตุ: Discord ห้าม custom_id ซ้ำในข้อความเดียว จึงต้องใส่ลำดับปุ่มต่อท้าย
  specs.forEach((spec, index) => {
    if (spec.action === 'link') {
      try {
        row.addComponents(buildLinkButton(spec));
      } catch {
        /* ข้ามลิงก์ที่ไม่ถูกต้อง */
      }
      return;
    }
    row.addComponents(
      buildButton(
        spec,
        spec.action === 'close' ? `ticket_close_${index}` : `ticket_create_${index}`,
        spec.action === 'close' ? 'ปิดตั๋ว' : 'สร้างห้องตั๋ว',
        spec.action === 'close' ? ButtonStyle.Danger : ButtonStyle.Primary,
      ),
    );
  });

  if (!row.components.length) {
    row.addComponents(
      buildButton(null, 'ticket_create_0', 'สร้างห้องตั๋ว', ButtonStyle.Primary),
    );
  }
  return row;
}

/** ส่งแผงปุ่ม Ticket ลงห้องที่เลือก */
async function handlePanelCommand(interaction) {
  const target = interaction.options.getChannel('channel') ?? interaction.channel;
  const cfg = getMessages().ticket;
  const { embed, files } = buildMessage(cfg, { serverName: interaction.guild.name });

  await target.send({
    embeds: [embed],
    files,
    components: [buildPanelRow(cfg.buttons)],
  });
  await interaction.reply({ content: `✅ ส่งแผง Ticket ไปที่ ${target} แล้ว`, flags: MessageFlags.Ephemeral });
}

/** ทำความสะอาดชื่อห้อง (เก็บตัวอักษรไทย/ตัวเลข/ขีด) */
function sanitizeChannelName(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .slice(0, 90);
}

/** ปุ่มสร้างห้องตั๋ว */
async function handleCreateButton(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;

  // หาว่ากดจากปุ่มไหน เพื่อเอาชื่อห้องตั๋วที่ตั้งไว้ของปุ่มนั้น
  const cfg = getMessages().ticket;
  const match = interaction.customId.match(/^ticket_create_(\d+)$/);
  const spec =
    match && Array.isArray(cfg.buttons) ? cfg.buttons[Number(match[1])] : null;

  // ถ้าผู้ใช้มีตั๋วที่เปิดอยู่แล้ว ไม่ต้องสร้างซ้ำ
  const existing = guild.channels.cache.find(
    (ch) => ch.isTextBased() && parseOwnerId(ch) === interaction.user.id,
  );
  if (existing) {
    await interaction.editReply({ content: `❌ คุณมีตั๋วที่เปิดอยู่แล้ว: ${existing}` });
    return;
  }

  const accessPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: accessPermissions },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  if (config.staffRoleId) {
    permissionOverwrites.push({ id: config.staffRoleId, allow: accessPermissions });
  }

  // ชื่อห้อง: ชื่อคน-ประเภทตามที่ตั้งไว้ในปุ่ม เช่น kxmzzz-สนใจเข้าสังกัด
  let name;
  if (spec?.ticketName) {
    name = sanitizeChannelName(
      `${interaction.user.username}-${spec.ticketName}`,
    );
  }
  if (!name) {
    name = sanitizeChannelName(`ticket-${interaction.user.username}`);
  }
  if (!name || name === sanitizeChannelName(interaction.user.username)) {
    name = `ticket-${interaction.user.id}`;
  }

  // ใช้หมวดหมู่จาก .env ถ้ามี ไม่งั้นใช้หมวดหมู่เดียวกับห้องที่กดปุ่ม
  const parentId = config.ticketCategoryId || interaction.channel?.parentId || undefined;

  const ticketChannel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `${OWNER_TAG}${interaction.user.id}`,
    permissionOverwrites,
  });

  const { embed, files } = buildMessage(
    {
      color: '#57f287',
      title: `🎟️ Ticket ของ ${interaction.user.username}`,
      description: [
        `เจ้าของตั๋ว: ${interaction.user}`,
        '',
        'อธิบายปัญหาหรือสิ่งที่ต้องการให้ทีมงานช่วยเหลือได้เลยครับ',
        'ทีมงานจะตอบกลับโดยเร็วที่สุด',
        ...(config.staffRoleId ? ['', '🔒 ปิดตั๋วได้เฉพาะทีมงานเท่านั้น'] : []),
      ].join('\n'),
      image: cfg.image,
    },
    {
      userId: interaction.user.id,
      username: interaction.user.username,
      serverName: guild.name,
    },
  );

  const closeRow = new ActionRowBuilder().addComponents(
    buildButton(findCloseSpec(cfg.buttons), 'ticket_close', 'ปิดตั๋ว', ButtonStyle.Danger),
  );

  await ticketChannel.send({
    content: config.staffRoleId ? `<@&${config.staffRoleId}>` : undefined,
    embeds: [embed],
    files,
    components: [closeRow],
  });

  await interaction.editReply({ content: `✅ สร้างตั๋วแล้ว: ${ticketChannel}` });
}

/** ปุ่มปิดตั๋ว (เฉพาะทีมงาน — แสดงการยืนยันก่อนลบห้อง) */
async function handleCloseButton(interaction) {
  const ownerId = parseOwnerId(interaction.channel);
  if (!ownerId) {
    await interaction.reply({
      content: '❌ ปุ่มนี้ใช้ได้เฉพาะในห้องตั๋วเท่านั้น (ใช้ปุ่ม "สร้างห้องตั๋ว" เพื่อเปิดตั๋ว)',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ถ้าตั้งยศทีมงานไว้ ต้องมียศนี้จึงจะปิดตั๋วได้ (เจ้าของตั๋วปิดเองไม่ได้)
  if (
    config.staffRoleId &&
    !interaction.member?.roles?.cache?.has(config.staffRoleId)
  ) {
    await interaction.reply({
      content: `⛔ ปิดตั๋วได้เฉพาะทีมงานที่มียศ <@&${config.staffRoleId}> เท่านั้น`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setDescription('⚠️ คุณแน่ใจหรือไม่ว่าต้องการปิดตั๋วนี้? ห้องนี้จะถูกลบถาวร');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_close_confirm')
      .setLabel('ยืนยันปิดตั๋ว')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ticket_close_cancel')
      .setLabel('ยกเลิก')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

/** จัดการปุ่มทั้งหมดของระบบ Ticket (รองรับหลายปุ่ม: ticket_create_0, ticket_close_1 ฯลฯ) */
async function handleTicketButton(interaction) {
  const id = interaction.customId;

  if (id === 'ticket_close_confirm') {
    await interaction.update({ content: '🔒 กำลังปิดตั๋ว...', embeds: [], components: [] });
    const channel = interaction.channel;
    setTimeout(() => {
      channel.delete('ผู้ใช้ปิดตั๋ว').catch(() => {});
    }, 3000);
    return;
  }

  if (id === 'ticket_close_cancel') {
    await interaction.update({ content: '✅ ยกเลิกการปิดตั๋วแล้ว', embeds: [], components: [] });
    return;
  }

  if (id === 'ticket_close' || id.startsWith('ticket_close_')) {
    await handleCloseButton(interaction);
    return;
  }

  if (id === 'ticket_create' || id.startsWith('ticket_create_')) {
    await handleCreateButton(interaction);
  }
}

module.exports = { panelCommand, handlePanelCommand, handleTicketButton, buildPanelRow };
