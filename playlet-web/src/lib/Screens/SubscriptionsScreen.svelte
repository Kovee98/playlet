<script lang="ts">
  import VideoListRow from "lib/VideoFeed/VideoListRow.svelte";
  import { playletStateStore, translate } from "lib/Stores";
  import { ProfileAuthState } from "lib/Types";
  import { PlayletApi } from "lib/Api/PlayletApi";
  import { onDestroy } from "svelte";
  import UserIcon from "../../assets/user.svg.svelte";
  import SubscriptionsIcon from "../../assets/subscriptions-icon.svg.svelte";

  export let visibility: boolean;
  let revision = 0;
  type SubscriptionChannel = {
    authorId: string;
    author: string;
    thumbnailUrl: string;
    latestUploadTimestamp: number;
  };
  let channels: SubscriptionChannel[] = [];
  let selectedChannelId = "";
  let channelsLoading = false;
  let channelsError = false;
  let uploadDatesIncomplete = false;
  let requestId = 0;
  let lastContext = "";
  let disposed = false;
  onDestroy(() => {
    disposed = true;
    requestId++;
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
    loadChannels(context);
  }
  $: feedKey = `${context}:${selectedChannelId}:${revision}`;
  $: selectedChannel = channels.find((channel) => channel.authorId === selectedChannelId);

  async function loadChannels(context: string) {
    const currentRequest = ++requestId;
    if (!context) channels = [];
    channelsError = false;
    uploadDatesIncomplete = false;
    channelsLoading = !!context;
    if (!context) return;
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
      channels = [...items.values()].sort((a, b) =>
        b.latestUploadTimestamp - a.latestUploadTimestamp ||
        (a.authorId < b.authorId ? -1 : a.authorId > b.authorId ? 1 : 0)
      );
      uploadDatesIncomplete = incomplete;
      if (selectedChannelId && !items.has(selectedChannelId)) {
        selectedChannelId = "";
      }
    } catch (error) {
      if (disposed || currentRequest !== requestId) return;
      console.error("Failed to load subscription channels", error);
      channelsError = true;
    } finally {
      if (!disposed && currentRequest === requestId) channelsLoading = false;
    }
  }

  function channelThumbnail(thumbnails?: { url: string }[]) {
    const url = thumbnails?.at(-1)?.url;
    if (!url) return "";
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) return `${$playletStateStore.invidious.instance}${url}`;
    return url;
  }

  function selectChannel(id: string) {
    if (selectedChannelId === id) return;
    selectedChannelId = id;
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function refresh() {
    revision++;
    loadChannels(context);
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
    min-width: 0;
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
