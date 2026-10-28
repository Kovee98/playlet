// Mirrors SubscriptionChannelsUtils.bs in playlet-lib.

// Each recently watched video from a channel counts like an upload 6 hours later,
// capped at 2 days, so upload recency stays the main signal.
const WATCH_BOOST_SECONDS = 21600;
const MAX_WATCH_BOOST_COUNT = 8;

export type ChannelForSort = {
  authorId: string;
  latestUploadTimestamp: number;
};

export type SeenState = {
  since: number;
  seen: Record<string, number>;
};

export function sortScore(channel: ChannelForSort, watchCounts?: Record<string, number>): number {
  const latest = channel.latestUploadTimestamp;
  if (typeof latest !== "number") return -1;
  const count = watchCounts?.[channel.authorId];
  if (latest <= 0 || !count || count <= 0) return latest;
  return latest + Math.min(count, MAX_WATCH_BOOST_COUNT) * WATCH_BOOST_SECONDS;
}

export function sortChannels<T extends ChannelForSort>(channels: T[], watchCounts?: Record<string, number>): T[] {
  return channels
    .map((channel) => ({ channel, score: sortScore(channel, watchCounts) }))
    .sort((a, b) =>
      b.score - a.score ||
      (a.channel.authorId < b.channel.authorId ? -1 : a.channel.authorId > b.channel.authorId ? 1 : 0)
    )
    .map((entry) => entry.channel);
}

export function summarizeWatchHistory(items: any[]) {
  const progress: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.videoId !== "string" || !item.videoId) continue;
    const percent = item.percentDurationWatched;
    if (typeof percent === "number" && percent > 0 && !(item.videoId in progress)) {
      progress[item.videoId] = percent;
    }
    if (typeof item.authorId === "string" && item.authorId) {
      counts[item.authorId] = (counts[item.authorId] || 0) + 1;
    }
  }
  return { progress, counts };
}

// Marks channels with uploads newer than what the user has seen. Returns a compacted
// state: "since" is a watermark below which nothing is new, and "seen" only keeps
// channels that would otherwise look new.
export function updateUnseen(
  channels: (ChannelForSort & { unseen?: boolean })[],
  state: SeenState | undefined,
  now: number
): SeenState {
  if (!state || typeof state.since !== "number" || !state.seen || typeof state.seen !== "object") {
    // First run: start from now so existing uploads are not all marked as new.
    state = { since: now, seen: {} };
  }
  const since = state.since;
  let oldestUnseen: number | undefined;
  let newestUpload = since;
  for (const channel of channels) {
    const latest = channel.latestUploadTimestamp;
    const seen = typeof state.seen[channel.authorId] === "number" ? state.seen[channel.authorId] : 0;
    channel.unseen = typeof latest === "number" && latest > since && latest > seen;
    if (channel.unseen && (oldestUnseen === undefined || latest < oldestUnseen)) {
      oldestUnseen = latest;
    }
    if (typeof latest === "number" && latest > newestUpload) {
      newestUpload = latest;
    }
  }
  const newSince = Math.max(since, oldestUnseen !== undefined ? oldestUnseen - 1 : newestUpload);
  const newSeen: Record<string, number> = {};
  for (const [authorId, seen] of Object.entries(state.seen)) {
    if (typeof seen === "number" && seen > newSince) newSeen[authorId] = seen;
  }
  return { since: newSince, seen: newSeen };
}

export function markSeen(state: SeenState | undefined, authorId: string, latestUploadTimestamp: number): boolean {
  if (!state?.seen || typeof latestUploadTimestamp !== "number") return false;
  const seen = state.seen[authorId];
  if (latestUploadTimestamp <= state.since || (typeof seen === "number" && latestUploadTimestamp <= seen)) {
    return false;
  }
  state.seen[authorId] = latestUploadTimestamp;
  return true;
}

function seenStorageKey(profileId: string) {
  return `playlet.subscriptions.seen.${profileId}`;
}

export function loadSeenState(profileId: string): SeenState | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(seenStorageKey(profileId)) || "null");
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function saveSeenState(profileId: string, state: SeenState) {
  try {
    localStorage.setItem(seenStorageKey(profileId), JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, quota); the dots just won't persist.
  }
}
