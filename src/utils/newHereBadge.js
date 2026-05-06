/**
 * "New here" pill: 72 hours from account creation, unless [users.new_here_until] overrides.
 * Used by GET /me, public profile, and feed so viewers see the badge even when [new_here_until] was never written.
 */

const NEW_HERE_MS = 72 * 60 * 60 * 1000;

/**
 * @param {{ created_at?: Date|string|null, new_here_until?: Date|string|null }} user
 * @returns {number} epoch ms when the badge expires, or NaN if unknown
 */
function effectiveNewHereUntilMs(user) {
  const createdAtMs = user.created_at ? new Date(user.created_at).getTime() : NaN;
  const storedUntilMs = user.new_here_until ? new Date(user.new_here_until).getTime() : NaN;
  const fallbackUntilMs = Number.isFinite(createdAtMs) ? createdAtMs + NEW_HERE_MS : NaN;
  if (Number.isFinite(storedUntilMs)) return storedUntilMs;
  if (Number.isFinite(fallbackUntilMs)) return fallbackUntilMs;
  return NaN;
}

/**
 * @param {{ created_at?: Date|string|null, new_here_until?: Date|string|null }} user
 */
function isNewHereBadgeActive(user) {
  const until = effectiveNewHereUntilMs(user);
  return Number.isFinite(until) && Date.now() < until;
}

module.exports = {
  NEW_HERE_MS,
  effectiveNewHereUntilMs,
  isNewHereBadgeActive,
};
