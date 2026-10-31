/**
 * The ticket room itself is the important result.  The welcome message is
 * best-effort so a slow Discord message send never makes the button appear
 * to be stuck after the room has already been created.
 */
async function createTicketFlow({
  findExisting,
  createChannel,
  announceExisting,
  announceOpened,
  sendWelcome,
  onWelcomeError = () => {},
}) {
  const existing = await findExisting();
  if (existing?.id) {
    await announceExisting(existing.id);
    return { created: false, channelId: existing.id };
  }

  const channel = await createChannel();
  if (!channel?.id) throw new Error('Discord did not return a ticket channel');

  await announceOpened(channel.id);
  if (sendWelcome) {
    Promise.resolve(sendWelcome(channel.id)).catch(onWelcomeError);
  }
  return { created: true, channelId: channel.id };
}

module.exports = { createTicketFlow };
