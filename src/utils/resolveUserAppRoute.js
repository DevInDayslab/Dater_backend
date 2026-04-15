/**
 * Canonical path hints for the mobile app (splash / post-login).
 * Keep in sync with Android [com.dater.navigation.AuthRouteResolver].
 */
function resolveUserAppRoute(user) {
  if (!user) return "/auth";
  const state = String(user.account_state || "ACTIVE");
  if (state === "PENDING_CAPTCHA") {
    return "/captcha-pending";
  }
  if (state !== "ACTIVE" && state !== "PRIVACY_MODE" && state !== "PAUSED") {
    return `/blocked/${state}`;
  }
  const onboardingUpdatedAt = user.onboarding_updated_at ? new Date(user.onboarding_updated_at).getTime() : null;
  const onboardingStale =
    !user.onboarding_completed_at &&
    onboardingUpdatedAt &&
    Date.now() - onboardingUpdatedAt > 7 * 24 * 60 * 60 * 1000;
  if (onboardingStale) {
    return "/onboarding/start";
  }
  return user.onboarding_completed_at ? "/home" : "/onboarding/resume";
}

module.exports = { resolveUserAppRoute };
