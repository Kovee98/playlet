<script lang="ts">
  import VideoListRow from "lib/VideoFeed/VideoListRow.svelte";
  import { invidiousVideoApiStore, playletStateStore, translate } from "lib/Stores";
  import { ProfileAuthState } from "lib/Types";
  import { PlayletApi } from "lib/Api/PlayletApi";
  import { InvidiousApi } from "lib/Api/InvidiousApi";
  import { onDestroy } from "svelte";
  import {
    FeedLoadState,
    clearFeedCache,
    getCachedFeedState,
    getOrCreateFeedState,
    loadFeedPage,
  } from "lib/VideoFeed/FeedLoader";
  import { getVideoThumbnailUrl } from "lib/VideoFeed/ThumbnailUrl";
  import {
    loadSeenState,
    markSeen,
    saveSeenState,
    sortChannels,
    summarizeWatchHistory,
    updateUnseen,
    type SeenState,
  } from "./SubscriptionUtils";
  import UserIcon from "../../assets/user.svg.svelte";
  import SubscriptionsIcon from "../../assets/subscriptions-icon.svg.svelte";

  const WATCH_HISTORY_PAGES = 3;
  const PREFETCH_DISTANCE = 2;
  const PREFETCH_THUMBNAILS_PER_FEED = 6;

  export let visibility: boolean;
  let revision = 0;
  type SubscriptionChannel = {
    authorId: string;
    author: string;
    thumbnailUrl: string;
    latestUploadTimestamp: number;
    unseen?: boolean;
  };
  let channels: SubscriptionChannel[] = [];
  let selectedChannelId = "";
  let channelsLoading = false;
  let channelsError = false;
  let uploadDatesIncomplete = false;
  let watchProgress: Record<string, number> = {};
  let seenState: SeenState | undefined;
  let seenProfileId = "";
  let requestId = 0;
  let prefetchId = 0;
  let lastContext = "";
  let disposed = false;

  const prefetchApi = new InvidiousApi();
  const unsubscribeState = playletStateStore.subscribe((value) => {
    prefetchApi.setInstance(value?.invidious?.instance);
    let userCountryCode = value?.device?.user_country_code;
    if (!userCountryCode || userCountryCode === "OT") {
      userCountryCode = "US";
    }
    prefetchApi.userCountryCode = userCountryCode;
    const currentProfile = (value?.profiles?.profiles ?? []).find(
      (p) => p.id === value?.profiles?.currentProfile
    );
    prefetchApi.isLoggedIn =
      !!currentProfile && currentProfile.authState !== ProfileAuthState.NeedsReauth;
  });
  const unsubscribeEndpoints = invidiousVideoApiStore.subscribe((value) => {
    prefetchApi.endpoints = value;
  });

  onDestroy(() => {
    disposed = true;
    requestId++;
    prefetchId++;
    unsubscribeState();
    unsubscribeEndpoints();
  });

  $: profile = ($playletStateStore.profiles?.profiles ?? []).find(
    (profile) => profile.id === $playletStateStore.profiles?.currentProfile
  );
  $: needsReauth = profile?.authState === ProfileAuthState.NeedsReauth;
  $: context = visibility && profile && !needsReauth
    ? `${profile.id}:${profile.authState}:${$playletStateStore.invidious?.instance}`
    : "";
  $: if (context !== lastContext) {
    lastContext = context;
    selectedChannelId = "";
    channels = [];
    watchProgress = {};
    clearFeedCache();
    loadChannels(context, profile?.id ?? "");
  }
  $: feedKey = `${context}:${selectedChannelId}:${revision}`;
  $: selectedChannel = channels.find((channel) => channel.authorId === selectedChannelId);

  async function loadChannels(context: string, profileId: string) {
    const currentRequest = ++requestId;
    prefetchId++;
    if (!context) channels = [];
    channelsError = false;
    uploadDatesIncomplete = false;
    channelsLoading = !!context;
    if (!context) return;
    const historyRequest = loadWatchHistory();
    const items = new Map<string, SubscriptionChannel>();
    const continuations = new Set<string>();
    let continuation = "";
    let incomplete = false;
    try {
      do {
        const result = await PlayletApi.invidiousAuthenticatedRequest({
          id: "subscription_channels",
          endpoint: "auth_subscriptions",
          state: { queryParams: continuation ? { continuation } : {} },
        });
        if (disposed || currentRequest !== requestId) return;
        if (!Array.isArray(result?.items)) {
          throw new Error("Invalid subscription channel list");
        }
        incomplete ||= result.uploadDatesIncomplete === true;
        for (const channel of result.items) {
          if (typeof channel.authorId === "string" && channel.authorId) {
            items.set(channel.authorId, {
              authorId: channel.authorId,
              author: channel.author || channel.authorId,
              thumbnailUrl: channelThumbnail(channel.authorThumbnails),
              latestUploadTimestamp: typeof channel.latestUploadTimestamp === "number"
                ? channel.latestUploadTimestamp : -1,
            });
          }
        }
        continuation = result.continuation || "";
        if (continuation && continuations.has(continuation)) {
          throw new Error("Repeated subscription channel continuation");
        }
        continuations.add(continuation);
      } while (continuation);
      const history = await historyRequest;
      if (disposed || currentRequest !== requestId) return;
      const loaded = sortChannels([...items.values()], history.counts);
      if (seenProfileId !== profileId) {
        seenProfileId = profileId;
        seenState = loadSeenState(profileId);
      }
      seenState = updateUnseen(loaded, seenState, Math.floor(Date.now() / 1000));
      channels = loaded;
      watchProgress = history.progress;
      uploadDatesIncomplete = incomplete;
      if (selectedChannelId && !items.has(selectedChannelId)) {
        selectedChannelId = "";
      }
      if (selectedChannelId) {
        markChannelSeen(selectedChannelId);
      }
      saveSeenState(profileId, seenState);
      schedulePrefetch();
    } catch (error) {
      if (disposed || currentRequest !== requestId) return;
      console.error("Failed to load subscription channels", error);
      channelsError = true;
    } finally {
      if (!disposed && currentRequest === requestId) channelsLoading = false;
    }
  }

  // Watch history supplies resume progress for channel feeds (which are fetched without the
  // account) and how often each channel is watched. It is optional, so failures are ignored.
  async function loadWatchHistory() {
    const items = [];
    let continuation = "";
    try {
      for (let page = 0; page < WATCH_HISTORY_PAGES; page++) {
        const result = await PlayletApi.invidiousAuthenticatedRequest({
          id: "subscription_watch_history",
          endpoint: "watch_history",
          state: { queryParams: continuation ? { continuation } : {} },
        });
        if (!Array.isArray(result?.items)) break;
        items.push(...result.items);
        if (!result.continuation || result.continuation === continuation) break;
        continuation = result.continuation;
      }
    } catch (error) {
      console.warn("Failed to load watch history for subscriptions", error);
    }
    return summarizeWatchHistory(items);
  }

  function channelThumbnail(thumbnails?: { url: string }[]) {
    const url = thumbnails?.at(-1)?.url;
    if (!url) return "";
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) return `${$playletStateStore.invidious.instance}${url}`;
    return url;
  }

  function markChannelSeen(id: string) {
    const channel = channels.find((channel) => channel.authorId === id);
    if (!channel?.unseen) return;
    channel.unseen = false;
    channels = channels;
    if (markSeen(seenState, id, channel.latestUploadTimestamp) && seenProfileId) {
      saveSeenState(seenProfileId, seenState);
    }
  }

  function selectChannel(id: string) {
    markChannelSeen(id);
    if (selectedChannelId === id) return;
    selectedChannelId = id;
    window.scrollTo({ top: 0, behavior: "instant" });
    schedulePrefetch();
  }

  function refresh() {
    clearFeedCache();
    revision++;
    loadChannels(context, profile?.id ?? "");
  }

  function feedCacheKey(channelId: string) {
    return `${context}:${revision}:${channelId}`;
  }

  // Loads the first page of the channels around the selected one, one at a time, so moving
  // to a neighbor shows its videos and thumbnails without waiting.
  async function schedulePrefetch() {
    const currentPrefetch = ++prefetchId;
    const ids = ["", ...channels.map((channel) => channel.authorId)];
    const index = Math.max(0, ids.indexOf(selectedChannelId));
    const neighbors = [];
    for (let distance = 1; distance <= PREFETCH_DISTANCE; distance++) {
      if (index + distance < ids.length) neighbors.push(ids[index + distance]);
      if (index - distance >= 0) neighbors.push(ids[index - distance]);
    }
    // Let the visible feed go first.
    await getCachedFeedState(feedCacheKey(selectedChannelId))?.task;
    for (const id of neighbors) {
      if (disposed || currentPrefetch !== prefetchId || !prefetchApi.canMakeRequest()) return;
      const channel = channels.find((channel) => channel.authorId === id);
      const state = getOrCreateFeedState(
        feedCacheKey(id),
        createFeed(id, channel?.author),
        channel?.latestUploadTimestamp
      );
      if (state.feedLoadState === FeedLoadState.None || state.task) {
        await loadFeedPage(state, prefetchApi);
        preloadThumbnails(state.videos);
      }
    }
  }

  function preloadThumbnails(videos: any[]) {
    const instance = $playletStateStore.invidious?.instance;
    for (const video of videos.slice(0, PREFETCH_THUMBNAILS_PER_FEED)) {
      const url = getVideoThumbnailUrl(video.videoId, video.videoThumbnails, instance);
      if (url) new Image().src = url;
    }
  }

  function createFeed(channelId: string, channelTitle: string) {
    return {
      id: "subscriptions",
      title: channelTitle || "All",
      feedSources: [channelId ? {
        id: "subscription_channel",
        title: channelTitle || "Videos",
        apiType: "Invidious",
        endpoint: "channel_videos",
        pathParams: { ucid: channelId },
        queryParams: { sort_by: "newest" },
      } : {
        id: "inv_auth_feed",
        title: "Subscriptions",
        apiType: "Invidious",
        endpoint: "auth_feed",
      }],
    };
  }
</script>

{#if visibility}
  <section aria-label={$translate("Subscriptions")}>
    <div class="flex items-center justify-between gap-2 m-4">
      <h1 class="text-2xl font-semibold">{$translate("Subscriptions")}</h1>
      {#if profile && !needsReauth}
        <button class="btn btn-sm" on:click={refresh}>
          {$translate("Refresh")}
        </button>
      {/if}
    </div>
    {#if !profile}
      <p class="m-4">
        {$translate("Use Profiles to activate an account. To sign in to YouTube, use your Roku device.")}
      </p>
    {:else if needsReauth}
      <p class="m-4" role="status">
        {$translate("The session has expired. Please sign in again with this profile, or switch to another profile.")}
      </p>
    {:else}
      <div class="subscriptions-layout">
        <nav aria-label={$translate("Subscriptions")} class="channel-nav">
          <button
            class="channel-button"
            class:selected={selectedChannelId === ""}
            aria-current={selectedChannelId === "" ? "true" : undefined}
            on:mouseenter={() => selectChannel("")}
            on:focus={() => selectChannel("")}
            on:click={() => selectChannel("")}
          >
            <span class="channel-logo" aria-hidden="true"><SubscriptionsIcon /></span>
            <span>{$translate("All")}</span>
          </button>
          {#each channels as channel (channel.authorId)}
            <button
              class="channel-button"
              class:selected={selectedChannelId === channel.authorId}
              aria-current={selectedChannelId === channel.authorId ? "true" : undefined}
              on:mouseenter={() => selectChannel(channel.authorId)}
              on:focus={() => selectChannel(channel.authorId)}
              on:click={() => selectChannel(channel.authorId)}
            >
              <span class="channel-logo" aria-hidden="true">
                <UserIcon />
                {#if channel.thumbnailUrl}
                  <img
                    src={channel.thumbnailUrl}
                    alt=""
                    width="32"
                    height="32"
                    loading="lazy"
                    on:error={() => channel.thumbnailUrl = ""}
                  />
                {/if}
              </span>
              <span class="channel-name">{channel.author}</span>
              {#if channel.unseen}
                <span class="unseen-dot" role="img" aria-label={$translate("New videos")}></span>
              {/if}
            </button>
          {/each}
          {#if channelsLoading}
            <p role="status" class="p-2 text-sm">{$translate("Loading subscriptions...")}</p>
          {/if}
          {#if channelsError}
            <p role="alert" class="p-2 text-sm">{$translate("Failed to load subscribed channels. Select Refresh to try again.")}</p>
          {/if}
          {#if uploadDatesIncomplete}
            <p role="alert" class="p-2 text-sm">{$translate("Some upload dates could not be checked. Those channels appear last. Select Refresh to retry.")}</p>
          {/if}
        </nav>
        <div class="min-w-0">
          {#key feedKey}
            <VideoListRow
              feed={createFeed(selectedChannelId, selectedChannel?.author)}
              cacheKey={feedCacheKey(selectedChannelId)}
              latestUploadTimestamp={selectedChannel?.latestUploadTimestamp}
              {watchProgress}
              showStatus
              layout="grid"
              emptyMessage={selectedChannelId
                ? "This channel has no videos yet."
                : "No subscription videos yet. Subscribe to channels to see their videos here."}
            />
          {/key}
        </div>
      </div>
    {/if}

  </section>
{/if}

<style>
  .subscriptions-layout {
    display: grid;
    grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr);
    gap: 1rem;
  }
  .channel-nav {
    position: sticky;
    top: 5rem;
    align-self: start;
    max-height: calc(100dvh - 10rem);
    overflow-y: auto;
    padding: 0 0.5rem;
  }
  .channel-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem;
    border-radius: 0.5rem;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .channel-logo {
    position: relative;
    flex: 0 0 2rem;
    width: 2rem;
    height: 2rem;
    overflow: hidden;
    border-radius: 50%;
  }
  .channel-logo :global(svg),
  .channel-logo img {
    width: 100%;
    height: 100%;
  }
  .channel-logo img {
    position: absolute;
    inset: 0;
    object-fit: cover;
  }
  .channel-name {
    flex: 1 1 auto;
    min-width: 0;
  }
  .unseen-dot {
    flex: 0 0 auto;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #3ea6ff;
  }
  .channel-button:hover,
  .channel-button:focus-visible,
  .channel-button.selected {
    background: var(--color-base-300);
  }
  @media (max-width: 640px) {
    .subscriptions-layout {
      grid-template-columns: 7rem minmax(0, 1fr);
      gap: 0;
    }
    .channel-button {
      padding: 0.5rem 0.25rem;
    }
    .channel-logo {
      flex-basis: 1.5rem;
      width: 1.5rem;
      height: 1.5rem;
    }
  }
</style>
