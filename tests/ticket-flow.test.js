const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const { createTicketFlow, closeTicketFlow } = require('../uplimit/ticket-flow');

test('reports the new ticket before the non-essential welcome message finishes', async () => {
  const events = [];
  let releaseWelcome;
  const welcomePending = new Promise((resolve) => { releaseWelcome = resolve; });

  const result = await createTicketFlow({
    findExisting: async () => null,
    createChannel: async () => ({ id: '123' }),
    announceOpened: async (id) => { events.push(`opened:${id}`); },
    sendWelcome: async () => { events.push('welcome:start'); await welcomePending; events.push('welcome:done'); },
  });

  assert.equal(result.created, true);
  assert.deepEqual(events, ['opened:123', 'welcome:start']);
  releaseWelcome();
});

test('does not create another ticket when an existing one is found', async () => {
  let created = false;
  const result = await createTicketFlow({
    findExisting: async () => ({ id: 'old' }),
    createChannel: async () => { created = true; },
    announceExisting: async (id) => assert.equal(id, 'old'),
  });

  assert.deepEqual(result, { created: false, channelId: 'old' });
  assert.equal(created, false);
});

test('reports a failed room deletion instead of leaving the ticket on a false closing state', async () => {
  const error = new Error('Discord 403: Missing Permissions');
  let reported = '';

  await assert.rejects(
    closeTicketFlow({
      deleteChannel: async () => { throw error; },
      announceFailure: async (message) => { reported = message; },
    }),
    error,
  );

  assert.match(reported, /403/);
});

test('new Ticket channels explicitly give Muffin permission to manage the channel', () => {
  const source = readFileSync(require.resolve('../server'), 'utf8');
  assert.match(source, /TICKET_BOT_ALLOW/);
  assert.match(source, /id: body\.application_id, type: 1, allow: TICKET_BOT_ALLOW/);
});
