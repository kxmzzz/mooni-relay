/**
 * Ticket buttons must remain usable when the optional Discord proxy has a
 * transient 5xx outage.  A proxy response other than 5xx is a real Discord
 * response and is returned untouched (for example 403/429).
 */
async function requestTicketDiscord(path, options = {}, {
  customBase = '',
  directBase = 'https://discord.com/api',
  request = fetch,
} = {}) {
  const endpoint = (base) => `${String(base).replace(/\/$/, '')}/v10${path}`;
  let proxyFailure = null;

  if (customBase) {
    try {
      const response = await request(endpoint(customBase), options);
      if (response.status < 500) return response;
      proxyFailure = new Error(`Ticket proxy HTTP ${response.status}`);
    } catch (err) {
      proxyFailure = err;
    }
  }

  try {
    return await request(endpoint(directBase), options);
  } catch (err) {
    if (proxyFailure) err.cause = proxyFailure;
    throw err;
  }
}

module.exports = { requestTicketDiscord };
