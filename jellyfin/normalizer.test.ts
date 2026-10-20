import { describe, expect, test } from 'bun:test';
import { isAnimeLibrary, isExcludedLibrary, isPrivateAnimeLibrary, normalizeJellyfinWebhook } from './normalizer';

describe('Jellyfin Webhook Normalizer', () => {
  test('isAnimeLibrary helper should identify anime and private anime libraries case-insensitively', () => {
    expect(isAnimeLibrary('Anime')).toBe(true);
    expect(isAnimeLibrary('Anime Shows')).toBe(true);
    expect(isAnimeLibrary('ANIME MOVIES')).toBe(true);
    expect(isAnimeLibrary('my-anime-collection')).toBe(true);

    // Matches private anime libraries
    expect(isAnimeLibrary('Other Anime', { privateAnimeLibraries: ['Other Anime', 'Other Anime Movies'] })).toBe(true);
    expect(isAnimeLibrary('Other Anime Movies', { privateAnimeLibraries: ['Other Anime', 'Other Anime Movies'] })).toBe(true);

    // Respects explicit excludedLibraries option
    expect(isAnimeLibrary('Other Anime', { excludedLibraries: ['Other Anime'] })).toBe(false);

    expect(isAnimeLibrary('TV Shows')).toBe(false);
    expect(isAnimeLibrary('Movies')).toBe(false);
    expect(isAnimeLibrary('Documentaries')).toBe(false);
    expect(isAnimeLibrary(undefined)).toBe(false);
    expect(isAnimeLibrary(null)).toBe(false);
  });

  test('isPrivateAnimeLibrary helper should identify private anime libraries case-insensitively', () => {
    const privates = ['Other Anime', 'Other Anime Movies'];
    expect(isPrivateAnimeLibrary('Other Anime', privates)).toBe(true);
    expect(isPrivateAnimeLibrary('Other Anime Movies', privates)).toBe(true);
    expect(isPrivateAnimeLibrary('other anime', privates)).toBe(true);
    expect(isPrivateAnimeLibrary('OTHER ANIME MOVIES', privates)).toBe(true);

    expect(isPrivateAnimeLibrary('Anime', privates)).toBe(false);
    expect(isPrivateAnimeLibrary('TV Shows', privates)).toBe(false);
    expect(isPrivateAnimeLibrary(undefined, privates)).toBe(false);
    expect(isPrivateAnimeLibrary(null, privates)).toBe(false);
  });

  test('isExcludedLibrary helper should identify excluded libraries when configured', () => {
    const excluded = ['Hidden Library', 'Adult Content'];
    expect(isExcludedLibrary('Hidden Library', excluded)).toBe(true);
    expect(isExcludedLibrary('hidden library', excluded)).toBe(true);

    expect(isExcludedLibrary('Anime', excluded)).toBe(false);
    expect(isExcludedLibrary('TV Shows', excluded)).toBe(false);
    expect(isExcludedLibrary(undefined)).toBe(false);
    expect(isExcludedLibrary(null)).toBe(false);
  });

  test('should normalize Episode webhook with flat Provider_ keys and LibraryName', () => {
    const raw = {
      NotificationType: 'PlaybackStop',
      NotificationUsername: 'testuser',
      ItemType: 'Episode',
      Name: 'The Journey Begins',
      SeriesName: 'Frieren: Beyond Journey’s End',
      SeriesId: 'series-guid-123',
      LibraryName: 'Anime Shows',
      SeasonNumber: 1,
      EpisodeNumber: 5,
      Year: 2023,
      PlaybackPositionTicks: 9000000000,
      RunTimeTicks: 10000000000, // 90%
      Provider_tvdb: '10052',
      Provider_tmdb: '209867',
      Series_Provider_tvdb: '439265',
    };

    const event = normalizeJellyfinWebhook(raw);

    expect(event.notificationType).toBe('PlaybackStop');
    expect(event.username).toBe('testuser');
    expect(event.itemType).toBe('Episode');
    expect(event.name).toBe('The Journey Begins');
    expect(event.seriesName).toBe('Frieren: Beyond Journey’s End');
    expect(event.seriesId).toBe('series-guid-123');
    expect(event.libraryName).toBe('Anime Shows');
    expect(event.seasonNumber).toBe(1);
    expect(event.episodeNumber).toBe(5);
    expect(event.progressPercentage).toBe(90);
    expect(event.isCompleted).toBe(true);
    expect(event.providerIds.tvdb).toBe('10052');
    expect(event.providerIds.tmdb).toBe('209867');
    expect(event.seriesProviderIds.tvdb).toBe('439265');
  });

  test('should normalize Movie webhook with nested ProviderIds', () => {
    const raw = {
      NotificationType: 'PlaybackStop',
      NotificationUsername: 'diana',
      ItemType: 'Movie',
      Name: 'Princess Mononoke',
      Library: 'Anime Movies',
      Year: 1997,
      PlaybackPositionTicks: 8500000000,
      RunTimeTicks: 10000000000, // 85%
      ProviderIds: {
        Tmdb: '128',
        Imdb: 'tt0119698',
      },
    };

    const event = normalizeJellyfinWebhook(raw);

    expect(event.itemType).toBe('Movie');
    expect(event.username).toBe('diana');
    expect(event.libraryName).toBe('Anime Movies');
    expect(event.isCompleted).toBe(true);
    expect(event.providerIds.tmdb).toBe('128');
    expect(event.providerIds.imdb).toBe('tt0119698');
  });

  test('should mark incomplete if progress < 80%', () => {
    const raw = {
      NotificationType: 'PlaybackStop',
      NotificationUsername: 'testuser',
      ItemType: 'Episode',
      PlaybackPositionTicks: 5000000000,
      RunTimeTicks: 10000000000, // 50%
      Played: false,
    };

    const event = normalizeJellyfinWebhook(raw);
    expect(event.progressPercentage).toBe(50);
    expect(event.isCompleted).toBe(false);
  });

  test('should mark complete if Played is true regardless of ticks', () => {
    const raw = {
      NotificationType: 'UserDataSaved',
      NotificationUsername: 'testuser',
      ItemType: 'Episode',
      PlaybackPositionTicks: 0,
      RunTimeTicks: 0,
      Played: true,
    };

    const event = normalizeJellyfinWebhook(raw);
    expect(event.isCompleted).toBe(true);
  });

  test('should parse episodeNumberEnd from IndexNumberEnd or EpisodeNumberEnd', () => {
    const raw = {
      NotificationType: 'PlaybackStop',
      NotificationUsername: 'testuser',
      ItemType: 'Episode',
      Name: 'Multi Part Episode',
      SeasonNumber: 1,
      IndexNumber: 1,
      IndexNumberEnd: 2,
      Played: true,
    };

    const event = normalizeJellyfinWebhook(raw);
    expect(event.episodeNumber).toBe(1);
    expect(event.episodeNumberEnd).toBe(2);
  });

  test('should normalize Series itemType and copy ProviderIds to seriesProviderIds', () => {
    const raw = {
      NotificationType: 'ItemAdded',
      ItemType: 'Series',
      ItemId: 'jf-series-guid',
      Name: 'Chainsaw Man',
      LibraryName: 'Anime',
      ProviderIds: {
        Tvdb: '393199',
        Tmdb: '114410',
      },
    };

    const event = normalizeJellyfinWebhook(raw);
    expect(event.itemType).toBe('Series');
    expect(event.itemId).toBe('jf-series-guid');
    expect(event.name).toBe('Chainsaw Man');
    expect(event.libraryName).toBe('Anime');
    expect(event.providerIds.tvdb).toBe('393199');
    expect(event.seriesProviderIds.tvdb).toBe('393199');
    expect(event.seriesProviderIds.tmdb).toBe('114410');
  });

  test('should normalize Season itemType and retain series info', () => {
    const raw = {
      NotificationType: 'ItemAdded',
      ItemType: 'Season',
      ItemId: 'jf-season-guid',
      SeriesId: 'jf-series-guid',
      Name: 'Season 1',
      SeriesName: 'Chainsaw Man',
      LibraryName: 'Anime',
      ProviderIds: { Tvdb: '2229470' },
      Series_Provider_tvdb: '393199',
    };

    const event = normalizeJellyfinWebhook(raw);
    expect(event.itemType).toBe('Season');
    expect(event.itemId).toBe('jf-season-guid');
    expect(event.seriesId).toBe('jf-series-guid');
    expect(event.providerIds.tvdb).toBe('2229470');
    expect(event.seriesProviderIds.tvdb).toBe('393199');
  });
});
