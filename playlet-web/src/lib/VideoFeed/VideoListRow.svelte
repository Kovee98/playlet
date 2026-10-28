<script lang="ts">
  import { InvidiousApi } from "lib/Api/InvidiousApi";
  import {
    invidiousVideoApiStore,
    playletStateStore,
    translate,
  } from "lib/Stores";
  import VideoCell from "./VideoCell.svelte";
  import PlaylistCell from "./PlaylistCell.svelte";
  import ChannelCell from "./ChannelCell.svelte";
  import { ProfileAuthState } from "lib/Types";
  import { onDestroy } from "svelte";
  import {
    FeedLoadState,
    createFeedState,
    getOrCreateFeedState,
    loadFeedPage,
    type FeedState,
  } from "./FeedLoader";

  // TODO:P1 figure out why some uncached feeds (e.g. channels/ucid/videos) get hit twice
  export let feed: any = undefined;
  export let showStatus = false;
  export let emptyMessage = "No subscription videos yet. Subscribe to channels to see their videos here.";
  export let layout: "row" | "grid" = "row";
  // When set, loaded pages are kept in a shared cache and restored instantly next time.
  export let cacheKey = "";
  export let latestUploadTimestamp: number | undefined = undefined;
  // videoId -> percent watched, overriding the progress the feed itself reports.
  export let watchProgress: Record<string, number> | undefined = undefined;
  let loadError = false;
  let videos = [];

  let feedLoadState = FeedLoadState.None;
  let feedState: FeedState;

  let itemWidths = [];

  let carouselElement;
  let carouselElementIntersecting = false;

  let scrollStart = 0;
  let scrollEnd = 0;

  let disposed = false;

  const intersectionObserver = new IntersectionObserver(
    function (entries) {
      carouselElementIntersecting = entries[0].isIntersecting;
      if (carouselElementIntersecting) {
        loadRow();
      }
    },
    { threshold: [0] }
  );

  $: {
    if (feed) {
      feedState = cacheKey
        ? getOrCreateFeedState(cacheKey, feed, latestUploadTimestamp)
        : createFeedState(feed);
      scrollStart = 0;
      scrollEnd = 0;
      syncFromFeedState();
      if (feedState.task) {
        // A prefetch for this feed is already running: show its results instead of
        // starting a duplicate request.
        awaitPendingLoad(feedState);
      }
    }
  }

  function syncFromFeedState() {
    if (disposed || !feedState) {
      return;
    }
    feedLoadState = feedState.feedLoadState;
    loadError = feedState.loadError;
    videos = feedState.videos;
    itemWidths = feedState.itemWidths;
  }

  async function awaitPendingLoad(state: FeedState) {
    await state.task;
    if (state !== feedState) {
      return;
    }
    syncFromFeedState();
    loadRow();
  }

  $: {
    if (
      carouselElement &&
      carouselElementIntersecting &&
      itemWidths &&
      itemWidths.length
    ) {
      recalculateVisibileCells();
    }
  }

  $: {
    if (videos && scrollEnd >= videos.length - 1) {
      loadRow();
    }
  }

  $: {
    if (carouselElement) {
      intersectionObserver.observe(carouselElement);
    }
  }

  let invidiousApi = new InvidiousApi();

  const unsubscribeState = playletStateStore.subscribe((value) => {
    invidiousApi.setInstance(value?.invidious?.instance);
    let userCountryCode = value?.device?.user_country_code;
    if (!userCountryCode || userCountryCode === "OT") {
      userCountryCode = "US";
    }
    invidiousApi.userCountryCode = userCountryCode;
    const currentProfile = (value.profiles?.profiles ?? []).find(
      (p) => p.id === value.profiles?.currentProfile
    );
    invidiousApi.isLoggedIn =
      !!currentProfile &&
      currentProfile.authState !== ProfileAuthState.NeedsReauth;
    loadRow();
  });

  const unsubscribeEndpoints = invidiousVideoApiStore.subscribe((value) => {
    invidiousApi.endpoints = value;
    loadRow();
  });

  onDestroy(() => {
    disposed = true;
    intersectionObserver.disconnect();
    unsubscribeState();
    unsubscribeEndpoints();
  });

  async function loadRow() {
    if (disposed) {
      return;
    }
    if (!invidiousApi.canMakeRequest()) {
      return;
    }

    if (!carouselElementIntersecting) {
      return;
    }

    if (layout === "row" && scrollEnd < videos.length - 3) {
      return;
    }

    if (
      feedLoadState === FeedLoadState.Loading ||
      feedLoadState === FeedLoadState.Loaded
    ) {
      return;
    }

    if (!feedState || feedState.task) {
      return;
    }

    const state = feedState;
    // Cached feeds keep loading after this row goes away so the cache still gets the page.
    const isCancelled = () => !cacheKey && (disposed || state !== feedState);
    feedLoadState = FeedLoadState.Loading;
    await loadFeedPage(
      state,
      invidiousApi,
      () => {
        if (state === feedState) {
          syncFromFeedState();
        }
      },
      isCancelled
    );
    if (state === feedState) {
      syncFromFeedState();
    }
  }

  function recalculateVisibileCells() {
    let scrollLeft = carouselElement.scrollLeft;
    const clientWidth = carouselElement.clientWidth || window.innerWidth;

    let _scrollStart = 0;
    while (
      _scrollStart < itemWidths.length &&
      scrollLeft > itemWidths[_scrollStart]
    ) {
      scrollLeft -= itemWidths[_scrollStart];
      _scrollStart++;
    }

    let _scrollEnd = _scrollStart;
    while (
      _scrollEnd < itemWidths.length &&
      scrollLeft + clientWidth > itemWidths[_scrollEnd]
    ) {
      scrollLeft -= itemWidths[_scrollEnd];
      _scrollEnd++;
    }

    _scrollStart = Math.max(0, _scrollStart - 1);
    _scrollEnd = Math.min(itemWidths.length - 1, _scrollEnd + 1);

    if (_scrollStart !== scrollStart) {
      scrollStart = _scrollStart;
    }
    if (_scrollEnd !== scrollEnd) {
      scrollEnd = _scrollEnd;
    }
  }
</script>

<!-- 
  Hide rows that are loaded but have no videos. Typically a 
  disabled feed (like popular) or unauthenticated. 
-->
{#if showStatus}
  <div class="m-4" role="status">
    {#if loadError}
      {$translate("Failed to load feed")}
    {:else if feedLoadState === FeedLoadState.None || feedLoadState === FeedLoadState.Loading}
      {$translate("Loading subscriptions...")}
    {:else if feedLoadState === FeedLoadState.Loaded && videos.length === 0}
      {$translate(emptyMessage)}
    {/if}
  </div>
{/if}
{#if feedLoadState !== FeedLoadState.Loaded || videos.length !== 0 || showStatus}
  <div class="text-lg font-semibold ml-4">
    {$translate(feed.title)}
  </div>
  {#if layout === "grid"}
    <div class="subscription-grid">
      {#each videos as video}
        <VideoCell
          {...video}
          percentDurationWatched={watchProgress?.[video.videoId] ?? video.percentDurationWatched}
          fullWidth
        />
      {/each}
    </div>
    <div bind:this={carouselElement} class="flex justify-center p-4">
      {#if feedLoadState === FeedLoadState.LoadedPage && !loadError}
        <button class="btn" on:click={loadRow}>{$translate("Load more")}</button>
      {/if}
    </div>
  {:else}
  <div
    class="carousel carousel-center rounded-box w-full space-x-4"
    style="min-height: 16rem;"
    bind:this={carouselElement}
    on:scroll={recalculateVisibileCells}
  >
    {#each videos as video, i}
      <div
        class="carousel-item {video.type === 'channel' ? 'w-60' : 'w-80'} p-2"
      >
        {#if i >= scrollStart && i <= scrollEnd}
          {#if video.type === "video"}
            <VideoCell
              {...video}
              percentDurationWatched={watchProgress?.[video.videoId] ?? video.percentDurationWatched}
            />
          {:else if video.type === "playlist"}
            <PlaylistCell {...video} />
          {:else if video.type === "channel"}
            <ChannelCell {...video} />
          {/if}
        {/if}
      </div>
    {/each}
  </div>
  {/if}
{/if}

<style>
  .subscription-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
    gap: 1rem;
    padding: 0 1rem;
  }
</style>
