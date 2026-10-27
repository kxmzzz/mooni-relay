const test = require('node:test');
const assert = require('node:assert/strict');
const { accessForUser, isBloxgateRequest } = require('../bloxgate');

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
