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

  // TODO:P1 figure out why some uncached feeds (e.g. channels/ucid/videos) get hit twice
  export let feed: any = undefined;
  export let showStatus = false;
  export let emptyMessage = "No subscription videos yet. Subscribe to channels to see their videos here.";
  export let layout: "row" | "grid" = "row";
  let loadError = false;
  let videos = [];

  enum FeedLoadState {
    None,
    Loading,
    Loaded,
    LoadedPage,
    Error,
  }

  let feedLoadState = FeedLoadState.None;
  let feedSourcesIndex = 0;

  let itemWidths = [];

  let carouselElement;
  let carouselElementIntersecting = false;

  let scrollStart = 0;
  let scrollEnd = 0;

  let loadDataTask = undefined;
  let disposed = false;

  // w-80|w-60 p-2: 320px|240px + 16px padding on each side
  const videoItemWidth = 320 + 16 * 2;
  const channelItemWidth = 240 + 16 * 2;

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
      feedSourcesIndex = 0;
      feedLoadState = FeedLoadState.None;
      loadError = false;
      videos = [];
      itemWidths = [];
      scrollStart = 0;
      scrollEnd = 0;
      loadDataTask = undefined;
    }
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

    if (loadDataTask) {
      return;
    }

    try {
      loadDataTask = loadData();
      await loadDataTask;
    } catch (error) {
      console.error(error);
      loadError = true;
      feedLoadState = FeedLoadState.Error;
    }
    loadDataTask = undefined;
  }

  async function loadData() {
    feedLoadState = FeedLoadState.Loading;
    let totalFetchedItems = 0;

    while (true) {
      const feedSources = feed.feedSources;
      if (disposed) {
        return;
      }
      if (feedSourcesIndex >= feedSources.length) {
        break;
      }

      const feedSource = feedSources[feedSourcesIndex];
      feedSource.state = feedSource.state || {};
      if (
        feedSource.state.loadState === FeedLoadState.Loaded ||
        feedSource.state.loadState === FeedLoadState.Error
      ) {
        feedSourcesIndex++;
        continue;
      }

      invidiousApi.markFeedSourcePagination(feedSource);
      let hadContinuation = !!feedSource.state.continuation;

      try {
        const result = await invidiousApi.makeRequest(feedSource);
        if (disposed) {
          return;
        }
        if (!result) {
          loadError = true;
          feedSource.state.loadState = FeedLoadState.Error;
          feedSourcesIndex++;
          if (feedSourcesIndex >= feedSources.length) {
            feedLoadState = FeedLoadState.Loaded;
          }
          continue;
        }

        let hasContinuation = !!result.continuation;
        feedSource.state.continuation = result.continuation || "";

        // See brightscript version for the "inv_auth_playlists" case
        const items =
          feedSource.id === "inv_auth_playlists"
            ? deduplicateAuthPlaylists(result.items)
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
          feedSourcesIndex >= feedSources.length - 1
        ) {
          feedLoadState = FeedLoadState.Loaded;
        } else {
          feedLoadState = FeedLoadState.LoadedPage;
        }

        const newVideos = items;

        newVideos.forEach((item) => {
          if (item.playlistId) {
            item.type = "playlist";
          } else if (item.videoId) {
            item.type = "video";
          }
        });

        const newItemWidths = newVideos.map((video) => {
          if (video.type === "channel") {
            return channelItemWidth;
          } else {
            return videoItemWidth;
          }
        });

        itemWidths = [...itemWidths, ...newItemWidths];
        videos = [...(videos || []), ...newVideos];

        totalFetchedItems += items.length;
        if (totalFetchedItems >= 6) {
          break;
        }
      } catch (error) {
        // TODO:P0 handle case of unauthenticated calls
        // TODO:P0 handle case of popular feed disabled
        // If we're done loading all the feed, but still have no videos, hide the whole component.
        console.error(error);
        loadError = true;
        feedSource.state.loadState = FeedLoadState.Error;
      }
    }
  }

  function deduplicateAuthPlaylists(items) {
    if (!items || items.length === 0) {
      return [];
    }

    if (videos.length === 0) {
      return items;
    }

    const existingPlaylistIds = new Set(
      videos.map((video) => video.playlistId).filter((id) => id)
    );

    const newItems = items.filter((item) => {
      if (item.playlistId && existingPlaylistIds.has(item.playlistId)) {
        return false;
      }
      return true;
    });
    return newItems;
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
        <VideoCell {...video} fullWidth />
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
            <VideoCell {...video} />
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
