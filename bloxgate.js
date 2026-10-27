function isBloxgateRequest(headers, configuredKey) {
  return Boolean(configuredKey) && headers?.['x-api-key'] === configuredKey;
}

function accessForUser(grants, userId, now = Date.now()) {
  const grant = grants?.[String(userId)];
  if (!grant) return { allowed: false, permanent: false, daysRemaining: null, expiresAt: null };
  if (grant.isPermanent) return { allowed: true, permanent: true, daysRemaining: null, expiresAt: null };
  const expiresAt = String(grant.expiresAt || '');
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || expires <= now) return { allowed: false, permanent: false, daysRemaining: null, expiresAt: null };
  return { allowed: true, permanent: false, daysRemaining: Math.max(1, Math.ceil((expires - now) / 86400000)), expiresAt };
}

module.exports = { accessForUser, isBloxgateRequest };
