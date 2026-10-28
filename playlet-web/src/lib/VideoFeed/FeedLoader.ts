import type { InvidiousApi } from "lib/Api/InvidiousApi";

export enum FeedLoadState {
  None,
  Loading,
  Loaded,
  LoadedPage,
  Error,
}

// w-80|w-60 p-2: 320px|240px + 16px padding on each side
const videoItemWidth = 320 + 16 * 2;
const channelItemWidth = 240 + 16 * 2;

export type FeedState = {
  feed: any;
  videos: any[];
  itemWidths: number[];
  feedSourcesIndex: number;
  feedLoadState: FeedLoadState;
  loadError: boolean;
  savedAt: number;
  task?: Promise<void>;
};

export function createFeedState(feed: any): FeedState {
  return {
    feed,
    videos: [],
    itemWidths: [],
    feedSourcesIndex: 0,
    feedLoadState: FeedLoadState.None,
    loadError: false,
    savedAt: Date.now() / 1000,
  };
}

// Loads the next page of a feed into its state. Concurrent callers share the same request.
// onUpdate is called whenever videos are appended; isCancelled stops loading early.
export function loadFeedPage(
  state: FeedState,
  api: InvidiousApi,
  onUpdate?: () => void,
  isCancelled: () => boolean = () => false
): Promise<void> {
  if (!state.task) {
    state.task = runLoad(state, api, onUpdate, isCancelled)
      .catch((error) => {
        console.error(error);
        state.loadError = true;
        state.feedLoadState = FeedLoadState.Error;
      })
      .finally(() => {
        state.task = undefined;
      });
  }
  return state.task;
}

async function runLoad(
  state: FeedState,
  api: InvidiousApi,
  onUpdate: (() => void) | undefined,
  isCancelled: () => boolean
) {
  state.feedLoadState = FeedLoadState.Loading;
  let totalFetchedItems = 0;

  while (true) {
    const feedSources = state.feed.feedSources;
    if (isCancelled()) {
      return;
    }
    if (state.feedSourcesIndex >= feedSources.length) {
      break;
    }

    const feedSource = feedSources[state.feedSourcesIndex];
    feedSource.state = feedSource.state || {};
    if (
      feedSource.state.loadState === FeedLoadState.Loaded ||
      feedSource.state.loadState === FeedLoadState.Error
    ) {
      state.feedSourcesIndex++;
      continue;
    }

    api.markFeedSourcePagination(feedSource);
    let hadContinuation = !!feedSource.state.continuation;

    try {
      const result = await api.makeRequest(feedSource);
      if (isCancelled()) {
        return;
      }
      if (!result) {
        state.loadError = true;
        feedSource.state.loadState = FeedLoadState.Error;
        state.feedSourcesIndex++;
        if (state.feedSourcesIndex >= feedSources.length) {
          state.feedLoadState = FeedLoadState.Loaded;
        }
        continue;
      }

      let hasContinuation = !!result.continuation;
      feedSource.state.continuation = result.continuation || "";

      // See brightscript version for the "inv_auth_playlists" and subscription feed cases
      const items =
        feedSource.id === "inv_auth_playlists"
          ? deduplicateAuthPlaylists(state.videos, result.items)
          : feedSource.id === "inv_auth_feed" || feedSource.id === "subscription_channel"
            ? deduplicateVideos(state.videos, result.items)
            : result.items || [];

      if (items.length > 0) {
        const paginationType = feedSource.state.paginationType;
        if (result.isLastPage || (hadContinuation && !hasContinuation)) {
          feedSource.state.loadState = FeedLoadState.Loaded;
        } else if (paginationType === "Continuation" && hasContinuation) {
          feedSource.state.loadState = FeedLoadState.LoadedPage;
        } else if (paginationType === "Pages") {
          feedSource.state.loadState = FeedLoadState.LoadedPage;
        } else {
          feedSource.state.loadState = FeedLoadState.Loaded;
        }
      } else {
        feedSource.state.loadState = FeedLoadState.Loaded;
      }

      if (
        feedSource.state.loadState === FeedLoadState.Loaded &&
        state.feedSourcesIndex >= feedSources.length - 1
      ) {
        state.feedLoadState = FeedLoadState.Loaded;
      } else {
        state.feedLoadState = FeedLoadState.LoadedPage;
      }

      items.forEach((item) => {
        if (item.playlistId) {
          item.type = "playlist";
        } else if (item.videoId) {
          item.type = "video";
        }
      });

      const newItemWidths = items.map((video) =>
        video.type === "channel" ? channelItemWidth : videoItemWidth
      );

      state.itemWidths = [...state.itemWidths, ...newItemWidths];
      state.videos = [...state.videos, ...items];
      onUpdate?.();

      totalFetchedItems += items.length;
      if (totalFetchedItems >= 6) {
        break;
      }
    } catch (error) {
      // TODO:P0 handle case of unauthenticated calls
      // TODO:P0 handle case of popular feed disabled
      console.error(error);
      state.loadError = true;
      feedSource.state.loadState = FeedLoadState.Error;
    }
  }
}

function deduplicateAuthPlaylists(videos: any[], items: any[]) {
  if (!items || items.length === 0) {
    return [];
  }

  if (videos.length === 0) {
    return items;
  }

  const existingPlaylistIds = new Set(
    videos.map((video) => video.playlistId).filter((id) => id)
  );

  return items.filter(
    (item) => !(item.playlistId && existingPlaylistIds.has(item.playlistId))
  );
}

export function deduplicateVideos(videos: any[], items: any[]) {
  if (!items || items.length === 0) {
    return [];
  }
  const seen = new Set(videos.map((video) => video.videoId).filter((id) => id));
  return items.filter((item) => {
    if (!item.videoId) {
      return true;
    }
    if (seen.has(item.videoId)) {
      return false;
    }
    seen.add(item.videoId);
    return true;
  });
}

// Keeps loaded feeds so switching back to one is instant. Entries expire after a while,
// or as soon as the channel has uploaded something newer than the cached copy.
const FEED_CACHE_SECONDS = 600;
const feedCache = new Map<string, FeedState>();

export function isFeedCacheFresh(
  savedAt: number,
  latestUploadTimestamp: number | undefined,
  now: number,
  maxAgeSeconds = FEED_CACHE_SECONDS
) {
  if (now - savedAt > maxAgeSeconds) {
    return false;
  }
  return !(typeof latestUploadTimestamp === "number" && latestUploadTimestamp > savedAt);
}

export function getCachedFeedState(
  key: string,
  latestUploadTimestamp?: number
): FeedState | undefined {
  const state = feedCache.get(key);
  if (!state) {
    return undefined;
  }
  if (
    state.loadError ||
    !isFeedCacheFresh(state.savedAt, latestUploadTimestamp, Date.now() / 1000)
  ) {
    feedCache.delete(key);
    return undefined;
  }
  return state;
}

export function getOrCreateFeedState(
  key: string,
  feed: any,
  latestUploadTimestamp?: number
): FeedState {
  let state = getCachedFeedState(key, latestUploadTimestamp);
  if (!state) {
    state = createFeedState(feed);
    feedCache.set(key, state);
  }
  return state;
}

export function clearFeedCache() {
  feedCache.clear();
}
