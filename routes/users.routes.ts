import { defaultJellyfinClient } from '../jellyfin';
import { appConfig } from '../shared/config';
import { validateAniListUserToken } from '../anilist/auth';
import { refreshUserToken, validateUserToken } from '../simkl/auth';
import { getAniListRedirectUri, getRedirectUri } from './auth.routes';

export const handleGetUsers = async (req: Request): Promise<Response> => {
  try {
    let jfUsers: { id: string; name: string }[] = [];
    try {
      jfUsers = await defaultJellyfinClient.getUsers();
    } catch (err) {
      console.error('Failed querying Jellyfin users for /api/users:', err);
    }
    const allUsernames = new Set<string>();

    for (const u of jfUsers) {
      allUsernames.add(u.name);
    }
    for (const u of Object.keys(appConfig.simkl.users || {})) {
      allUsernames.add(u);
    }
    for (const u of Object.keys(appConfig.anilist?.users || {})) {
      allUsernames.add(u);
    }

    const userStatuses = await Promise.all(
      Array.from(allUsernames).map(async (username) => {
        // Check Simkl status
        let simklEntry = appConfig.simkl.users[username];
        let simklStatus = {
          isConfigured: false,
          isValid: false,
          simklUsername: undefined as string | undefined,
          expiresInDays: undefined as number | undefined,
          hasRefreshToken: false,
          error: undefined as string | undefined,
        };

        if (simklEntry) {
          const ONE_DAY_MS = 24 * 60 * 60 * 1000;
          if (
            typeof simklEntry === 'object' &&
            simklEntry?.refresh_token &&
            simklEntry?.expires_at
          ) {
            if (Date.now() + ONE_DAY_MS >= simklEntry.expires_at) {
              try {
                await refreshUserToken(username);
                simklEntry = appConfig.simkl.users[username];
              } catch (e) {
                console.error(`Auto-refresh during status check failed for "${username}":`, e);
              }
            }
          }

          const check = await validateUserToken(simklEntry);
          let expiresInDays: number | undefined;
          const hasRefreshToken =
            typeof simklEntry === 'object' && Boolean(simklEntry?.refresh_token);

          if (typeof simklEntry === 'object' && simklEntry?.expires_at) {
            const diffMs = simklEntry.expires_at - Date.now();
            expiresInDays = Math.max(0, Math.round(diffMs / (24 * 60 * 60 * 1000)));
          }

          simklStatus = {
            isConfigured: true,
            isValid: check.valid,
            simklUsername: check.simklUsername,
            expiresInDays,
            hasRefreshToken,
            error: check.error,
          };
        }

        // Check AniList status
        const anilistEntry = appConfig.anilist?.users?.[username];
        let anilistStatus = {
          isConfigured: false,
          isValid: false,
          anilistUsername: undefined as string | undefined,
          anilistUserId: undefined as number | undefined,
          expiresInDays: undefined as number | undefined,
          error: undefined as string | undefined,
        };

        if (anilistEntry) {
          const check = await validateAniListUserToken(anilistEntry);
          let expiresInDays: number | undefined;
          if (typeof anilistEntry === 'object' && anilistEntry?.expires_at) {
            const diffMs = anilistEntry.expires_at - Date.now();
            expiresInDays = Math.max(0, Math.round(diffMs / (24 * 60 * 60 * 1000)));
          }

          anilistStatus = {
            isConfigured: true,
            isValid: check.valid,
            anilistUsername: check.anilistUsername,
            anilistUserId: check.anilistUserId,
            expiresInDays,
            error: check.error,
          };
        }

        return {
          username,
          simkl: simklStatus,
          anilist: anilistStatus,
          // Top-level backwards compatibility
          isConfigured: simklStatus.isConfigured,
          isValid: simklStatus.isValid,
          simklUsername: simklStatus.simklUsername,
          expiresInDays: simklStatus.expiresInDays,
          hasRefreshToken: simklStatus.hasRefreshToken,
          error: simklStatus.error,
        };
      }),
    );

    const simklRedirectUri = getRedirectUri(req);
    const anilistRedirectUri = getAniListRedirectUri(req);

    return Response.json({
      simkl: {
        configured: Boolean(appConfig.simkl.client_id),
        clientId: appConfig.simkl.client_id,
        hasClientSecret: Boolean(appConfig.simkl.client_secret),
        redirectUri: simklRedirectUri,
      },
      anilist: {
        configured: Boolean(appConfig.anilist?.client_id),
        clientId: appConfig.anilist?.client_id,
        hasClientSecret: Boolean(appConfig.anilist?.client_secret),
        redirectUri: anilistRedirectUri,
      },
      jellyfinUsers: jfUsers,
      users: userStatuses,
    });
  } catch (err: any) {
    console.error('Error in /api/users GET handler:', err);
    return Response.json(
      { error: err?.message || 'Failed to retrieve user statuses' },
      { status: 500 },
    );
  }
};

export const handleRefreshUser = async (req: Request): Promise<Response> => {
  try {
    const body = (await req.json()) as { username?: string };
    if (!body?.username) {
      return Response.json({ message: 'Missing username parameter' }, { status: 400 });
    }
    await refreshUserToken(body.username);
    return Response.json({ status: 'refreshed', username: body.username });
  } catch (error) {
    console.error('Failed to refresh user token:', error);
    return Response.json(
      { message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
};
