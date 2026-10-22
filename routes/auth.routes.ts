import { appConfig, saveAniListUserToken, saveUserToken } from '../shared/config';
import {
  consumeAniListOAuthSession,
  exchangeCodeForAniListToken,
  getAniListAuthUrl,
} from '../anilist/auth';
import {
  consumeOAuthSession,
  exchangeCodeForToken,
  getSimklAuthUrl,
} from '../simkl/auth';

export const getRedirectUri = (req: Request): string => {
  if (appConfig.simkl.redirect_uri) {
    return appConfig.simkl.redirect_uri;
  }
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  const proto =
    req.headers.get('x-forwarded-proto') || (url.protocol.startsWith('https') ? 'https' : 'http');
  return `${proto}://${host}/auth/callback`;
};

export const getAniListRedirectUri = (req: Request): string => {
  if (appConfig.anilist?.redirect_uri) {
    return appConfig.anilist.redirect_uri;
  }
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  const proto =
    req.headers.get('x-forwarded-proto') || (url.protocol.startsWith('https') ? 'https' : 'http');
  return `${proto}://${host}/auth/anilist/callback`;
};

export const handleSimklLogin = (req: Request): Response => {
  const url = new URL(req.url);
  const username = url.searchParams.get('username');

  if (!username) {
    return Response.redirect('/?error=No+username+specified', 302);
  }

  const redirectUri = getRedirectUri(req);
  console.log(
    `[OAuth] Initiating authorization for user "${username}" with redirect_uri: "${redirectUri}"`,
  );
  try {
    const { url: authUrl } = getSimklAuthUrl(username, redirectUri);
    return Response.redirect(authUrl, 302);
  } catch (err) {
    return Response.redirect(
      `/?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
      302,
    );
  }
};

export const handleSimklCallback = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const iss = url.searchParams.get('iss');
  const error = url.searchParams.get('error');

  if (error) {
    return Response.redirect(`/?error=${encodeURIComponent(error)}`, 302);
  }

  if (iss && iss !== 'https://simkl.com') {
    return Response.redirect('/?error=Authorization+response+did+not+come+from+Simkl', 302);
  }

  if (!code || !state) {
    return Response.redirect('/?error=Missing+authorization+code+or+state', 302);
  }

  const session = consumeOAuthSession(state);
  if (!session) {
    return Response.redirect(
      '/?error=Invalid+or+expired+authorization+session.+Please+try+again.',
      302,
    );
  }

  const { username, verifier, redirectUri } = session;

  try {
    const result = await exchangeCodeForToken(code, redirectUri, verifier);
    const expiresInSeconds = result.expiresIn ?? 7 * 24 * 60 * 60; // 7 days default
    const expiresAt = Date.now() + expiresInSeconds * 1000;

    await saveUserToken(username, {
      token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_at: expiresAt,
    });
    console.log(`Successfully authenticated and saved Simkl token for user "${username}"`);
    return Response.redirect(`/?success=${encodeURIComponent(username)}`, 302);
  } catch (err) {
    console.error(`Error exchanging Simkl code for user "${username}":`, err);
    return Response.redirect(
      `/?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
      302,
    );
  }
};

export const handleAniListLogin = (req: Request): Response => {
  const url = new URL(req.url);
  const username = url.searchParams.get('username');

  if (!username) {
    return Response.redirect('/?error=No+username+specified', 302);
  }

  const redirectUri = getAniListRedirectUri(req);
  console.log(
    `[OAuth] Initiating AniList authorization for user "${username}" with redirect_uri: "${redirectUri}"`,
  );
  try {
    const { url: authUrl } = getAniListAuthUrl(username, redirectUri);
    return Response.redirect(authUrl, 302);
  } catch (err) {
    return Response.redirect(
      `/?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
      302,
    );
  }
};

export const handleAniListCallback = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  if (error) {
    return Response.redirect(`/?error=${encodeURIComponent(errorDesc || error)}`, 302);
  }

  if (!code || !state) {
    return Response.redirect('/?error=Missing+authorization+code+or+state', 302);
  }

  const session = consumeAniListOAuthSession(state);
  if (!session) {
    return Response.redirect(
      '/?error=Invalid+or+expired+authorization+session.+Please+try+again.',
      302,
    );
  }

  const { username, redirectUri } = session;

  try {
    const result = await exchangeCodeForAniListToken(code, redirectUri);
    const expiresInSeconds = result.expiresIn ?? 31536000; // 1 year default
    const expiresAt = Date.now() + expiresInSeconds * 1000;

    await saveAniListUserToken(username, {
      token: result.accessToken,
      expires_at: expiresAt,
    });
    console.log(`Successfully authenticated and saved AniList token for user "${username}"`);
    return Response.redirect(
      `/?success=${encodeURIComponent(username)}&service=anilist`,
      302,
    );
  } catch (err) {
    console.error(`Error exchanging AniList code for user "${username}":`, err);
    return Response.redirect(
      `/?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`,
      302,
    );
  }
};
