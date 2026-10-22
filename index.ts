import path from 'node:path';
import { defaultAnimeResolver } from './anime';
import type { RawJellyfinPayload } from './jellyfin';
import { handleWebhook } from './main';
import {
  handleGetOverrides,
  handleImportOverrides,
  handleRetireRedundantOverrides,
  handleSaveOverrides,
  handleSyncCatalog,
  handleSyncSeries,
} from './overrides/api';
import {
  handleAniListCallback,
  handleAniListLogin,
  handleSimklCallback,
  handleSimklLogin,
} from './routes/auth.routes';
import { handleGetUsers, handleRefreshUser } from './routes/users.routes';
import { startBackgroundJobs } from './server/scheduler';
import { serveSpa, serveStaticOrSpaFallback } from './server/static';
import { initLogger } from './shared/logger';
import { flushAllAniListQueues } from './anilist/scrobbler';
import { flushAllPendingSeriesSync } from './overrides/series-debouncer';
import { flushAllQueues } from './simkl/batcher';

// Re-exports for backwards compatibility
export { checkAndRefreshExpiringTokens } from './server/scheduler';
export { serveSpa } from './server/static';

// Initialize configurable logger
initLogger();

// Start periodic background tasks & initial warmup
startBackgroundJobs();

const publicDir = path.resolve(import.meta.dir, 'public');

const server = Bun.serve({
  port: 3000,
  routes: {
    '/': { GET: serveSpa },
    '/auth': { GET: serveSpa },
    '/overrides': { GET: serveSpa },

    // API routes
    '/api/users': { GET: handleGetUsers },
    '/api/users/refresh': { POST: handleRefreshUser },
    '/api/overrides': {
      GET: handleGetOverrides,
      POST: handleSaveOverrides,
    },
    '/api/overrides/import': { POST: handleImportOverrides },
    '/api/catalog/sync': { POST: handleSyncCatalog },
    '/api/catalog/sync-series': { POST: handleSyncSeries },
    '/api/series/sync': { POST: handleSyncSeries },
    '/api/overrides/retire-redundant': { POST: (req) => handleRetireRedundantOverrides(req) },

    // OAuth routes
    '/auth/login': { GET: handleSimklLogin },
    '/auth/simkl/login': { GET: handleSimklLogin },
    '/auth/callback': { GET: handleSimklCallback },
    '/auth/anilist/login': { GET: handleAniListLogin },
    '/auth/anilist/callback': { GET: handleAniListCallback },

    // Webhook & Mappings
    '/webhook': {
      POST: async (req) => {
        const payload = (await req.json()) as RawJellyfinPayload;
        handleWebhook(payload).catch((error) => {
          console.error('Failed executing background webhook handler:', error);
        });
        return Response.json({ status: 'processed' });
      },
    },
    '/mappings/refresh': {
      POST: async () => {
        console.log('Manual mapping refresh triggered via /mappings/refresh');
        try {
          await defaultAnimeResolver.initialize({ forceRefresh: true });
          return Response.json({ status: 'refreshed' });
        } catch (error) {
          console.error('Error during manual mapping refresh:', error);
          return Response.json({ status: 'error', message: String(error) }, { status: 500 });
        }
      },
    },
  },
  async fetch(req) {
    return serveStaticOrSpaFallback(req, publicDir);
  },
  error(error) {
    console.error('Bun.serve unhandled server error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
});

console.log(`Server running at ${server.port}`);

const handleShutdown = async (signal: string) => {
  console.log(`Received ${signal}. Flushing pending scrobbles before exiting...`);
  try {
    await flushAllQueues();
    await flushAllAniListQueues();
    await flushAllPendingSeriesSync();
  } catch (err) {
    console.error('Error flushing queues during shutdown:', err);
  }
  process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
