const test = require('node:test');
const assert = require('node:assert/strict');

const { requestTicketDiscord } = require('../uplimit/ticket-request');

test('falls back to Discord directly when the configured ticket proxy has a server error', async () => {
  const calls = [];
  const response = await requestTicketDiscord('/channels/123', { method: 'DELETE' }, {
    customBase: 'https://proxy.example/key',
    directBase: 'https://discord.com/api',
    request: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? new Response('Site unavailable', { status: 502 })
        : new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 204);
  assert.deepEqual(calls, [
    'https://proxy.example/key/v10/channels/123',
    'https://discord.com/api/v10/channels/123',
  ]);
});

test('uses the proxy response without a direct retry when Discord accepts the request', async () => {
  let calls = 0;
  const response = await requestTicketDiscord('/channels/123', {}, {
    customBase: 'https://proxy.example/key',
    directBase: 'https://discord.com/api',
    request: async () => { calls += 1; return new Response(null, { status: 204 }); },
  });

  assert.equal(response.status, 204);
  assert.equal(calls, 1);
});
