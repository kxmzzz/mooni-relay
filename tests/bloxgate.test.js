const test = require('node:test');
const assert = require('node:assert/strict');
const { accessForUser, isBloxgateRequest, removeExpiredGrants } = require('../bloxgate');
const { readFileSync } = require('node:fs');

test('accepts only the configured Bloxgate API key', () => {
  assert.equal(isBloxgateRequest({ 'x-api-key': 'correct' }, 'correct'), true);
  assert.equal(isBloxgateRequest({ 'x-api-key': 'wrong' }, 'correct'), false);
});

test('returns remaining days for an active timed grant', () => {
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  assert.deepEqual(accessForUser({ u1: { expiresAt: '2030-01-03T00:00:00.000Z' } }, 'u1', now), {
    allowed: true, permanent: false, daysRemaining: 2, expiresAt: '2030-01-03T00:00:00.000Z',
  });
});

test('rejects expired grants and accepts permanent grants', () => {
  const now = Date.parse('2030-01-02T00:00:00.000Z');
  assert.equal(accessForUser({ expired: { expiresAt: '2030-01-01T00:00:00.000Z' } }, 'expired', now).allowed, false);
  assert.deepEqual(accessForUser({ forever: { isPermanent: true } }, 'forever', now), {
    allowed: true, permanent: true, daysRemaining: null, expiresAt: null,
  });
});

test('removes expired timed grants but retains permanent grants', () => {
  const grants = {
    expired: { expiresAt: '2030-01-01T00:00:00.000Z' },
    active: { expiresAt: '2030-01-03T00:00:00.000Z' },
    permanent: { isPermanent: true },
  };
  assert.equal(removeExpiredGrants(grants, Date.parse('2030-01-02T00:00:00.000Z')), true);
  assert.deepEqual(Object.keys(grants).sort(), ['active', 'permanent']);
});

test('relay exposes map discovery and protected grant management endpoints', () => {
  const source = readFileSync(require.resolve('../server'), 'utf8');
  assert.match(source, /\/api\/roblox\/maps/);
  assert.match(source, /\/api\/roblox\/grants/);
  assert.match(source, /Roblox username was not found/);
  assert.match(source, /Access-Control-Allow-Methods/);
  assert.match(source, /thumbnails\.roblox\.com\/v1\/users\/avatar-headshot/);
  assert.match(source, /games\.roblox\.com\/v1\/games/);
  assert.match(source, /thumbnails\.roblox\.com\/v1\/games\/icons/);
  assert.match(source, /Mooni Bloxgate Admin/);
  assert.match(source, /bloxgate-admin\.html/);
});
