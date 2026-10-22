import path from 'node:path';

/**
 * Serves the compiled Angular SPA index.html, with fallback notice if assets are unbuilt.
 */
export const serveSpa = async (): Promise<Response> => {
  const publicIndex = Bun.file(path.join(import.meta.dir, '..', 'public', 'index.html'));
  if (await publicIndex.exists()) {
    return new Response(publicIndex, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(
    '<!DOCTYPE html><html><body><h1>Jellyfin Tracker Sync</h1><p>Frontend assets not built. Run <code>cd frontend && bun run build</code>.</p></body></html>',
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
};

/**
 * Handles static asset requests from the public directory with path-traversal prevention,
 * and falls back to SPA index.html for client-side routing.
 */
export const serveStaticOrSpaFallback = async (
  req: Request,
  publicDir: string,
): Promise<Response> => {
  const url = new URL(req.url);
  const safePath = path.resolve(publicDir, '.' + url.pathname);

  // Prevent directory traversal attacks
  if (safePath.startsWith(publicDir)) {
    const file = Bun.file(safePath);
    if (await file.exists()) {
      return new Response(file);
    }
  }

  // SPA client-side routing fallback for frontend paths
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    !url.pathname.startsWith('/api') &&
    !url.pathname.startsWith('/auth') &&
    !url.pathname.startsWith('/webhook')
  ) {
    const indexFile = Bun.file(path.join(publicDir, 'index.html'));
    if (await indexFile.exists()) {
      if (req.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(indexFile, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
};
