const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

process.env.UPLIMIT_WELCOME_CHANNEL_ID = '111111111111111111';
const { sendWelcome, resolveWelcomeChannel, welcomeStatus } = require('../uplimit/welcome');

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];

function fakeChannel(id, name, { perms = ALL, sendError = null } = {}) {
  const sent = [];
  return {
    id,
    name,
    sent,
    isTextBased: () => true,
    permissionsFor: () => ({ has: (bit) => perms.includes(bit) }),
    send: async (payload) => {
      if (sendError) throw sendError;
      sent.push(payload);
    },
  };
}

function fakeGuild({ cached = [], fetchable = [], system = null } = {}) {
  const cache = new Map(cached.map((c) => [c.id, c]));
  return {
    name: 'Uplimit Media',
    memberCount: 10,
    systemChannel: system,
    members: { me: { id: 'bot' }, cache: new Map() },
    channels: {
      cache,
      fetch: async (id) => {
        const c = fetchable.find((x) => x.id === id);
        if (!c) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return c;
      },
    },
  };
}

const fakeMember = (guild) => ({
  id: '222222222222222222',
  guild,
  user: { username: 'newbie', tag: 'newbie' },
  displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
});

test('sends the welcome embed with the logo into the configured channel', async () => {
  const ch = fakeChannel('111111111111111111', 'welcome');
  const guild = fakeGuild({ cached: [ch] });
  assert.equal(await sendWelcome(fakeMember(guild)), true);
  assert.equal(ch.sent.length, 1);
  const { embeds, files } = ch.sent[0];
  assert.equal(embeds[0].data.title, 'ยินดีต้อนรับสู่สังกัด Uplimit Media');
  assert.match(embeds[0].data.description, /<@222222222222222222>/);
  assert.equal(embeds[0].data.image.url, 'attachment://logo.jpg');
  assert.equal(files.length, 1);
  assert.equal(welcomeStatus().lastSent.user, 'newbie');
});

test('fetches the configured channel when it is not in the cache', async () => {
  const ch = fakeChannel('111111111111111111', 'welcome');
  const guild = fakeGuild({ fetchable: [ch] });
  assert.equal(await sendWelcome(fakeMember(guild)), true);
  assert.equal(ch.sent.length, 1);
});

test('falls back to the server system channel when the configured one is gone', async () => {
  const sys = fakeChannel('333', 'system');
  const guild = fakeGuild({ system: sys });
  assert.equal(await sendWelcome(fakeMember(guild)), true);
  assert.equal(sys.sent.length, 1);
  const s = welcomeStatus();
  assert.equal(s.source, 'system');
  assert.match(s.problem, /ไม่พบห้อง/);
});

test('records missing permissions and the Discord error instead of failing silently', async () => {
  const err = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const ch = fakeChannel('111111111111111111', 'welcome', {
    perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    sendError: err,
  });
  const guild = fakeGuild({ cached: [ch] });
  assert.equal(await sendWelcome(fakeMember(guild)), false);
  const s = welcomeStatus();
  assert.deepEqual(s.missingPerms, ['EmbedLinks', 'AttachFiles']);
  assert.equal(s.lastError.error, '50013 Missing Permissions');
});

test('reports no channel when nothing is configured or available', async () => {
  const r = await resolveWelcomeChannel(fakeGuild(), null);
  assert.equal(r.channel, null);
  assert.equal(r.problem, 'ไม่ได้ตั้ง UPLIMIT_WELCOME_CHANNEL_ID');
});
