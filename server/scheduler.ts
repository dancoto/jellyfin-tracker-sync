import { defaultAnimeResolver } from '../anime';
import { refreshUserToken } from '../simkl/auth';
import { appConfig } from '../shared/config';

/**
 * Proactively check and refresh any Simkl tokens expiring within 48 hours.
 */
export const checkAndRefreshExpiringTokens = async (): Promise<void> => {
  const users = appConfig.simkl.users || {};
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

  for (const [username, entry] of Object.entries(users)) {
    if (typeof entry === 'object' && entry?.refresh_token && entry?.expires_at) {
      if (Date.now() + TWO_DAYS_MS >= entry.expires_at) {
        console.log(
          `Simkl access token for "${username}" is nearing expiration. Refreshing now...`,
        );
        try {
          await refreshUserToken(username);
        } catch (err) {
          console.error(`Background token refresh failed for "${username}":`, err);
        }
      }
    }
  }
};

/**
 * Starts background tasks:
 * 1. Immediate startup initialization of anime resolver & token refresh check.
 * 2. Scheduled 24-hour interval for updating mapping indices and auto-refreshing user tokens.
 */
export const startBackgroundJobs = (): ReturnType<typeof setInterval> => {
  // Initialize anime mapping resolver and token refresh check on startup
  defaultAnimeResolver.initialize().catch((error) => {
    console.error('Failed to initialize anime resolver on startup:', error);
  });

  checkAndRefreshExpiringTokens().catch((error) => {
    console.error('Failed checking expiring tokens on startup:', error);
  });

  // Automatically check and refresh expired mapping caches & user tokens every 24 hours
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  const interval = setInterval(() => {
    console.log('Running scheduled daily check for anime mapping updates & token refresh...');
    defaultAnimeResolver.initialize().catch((error) => {
      console.error('Failed to refresh anime mappings in background:', error);
    });
    checkAndRefreshExpiringTokens().catch((error) => {
      console.error('Failed to auto-refresh expiring user tokens in background:', error);
    });
  }, TWENTY_FOUR_HOURS_MS);

  return interval;
};
