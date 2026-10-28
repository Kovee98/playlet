export function getVideoThumbnailUrl(
  videoId: string | undefined,
  videoThumbnails: any[] | undefined,
  invidiousInstance: string | undefined
): string | undefined {
  if (videoThumbnails && videoThumbnails.length > 0) {
    const videoThumbnail =
      videoThumbnails.find((thumbnail) => thumbnail.quality === "medium") ||
      videoThumbnails[0];
    let url = videoThumbnail.url;
    if (url.startsWith("/")) {
      if (
        invidiousInstance &&
        !invidiousInstance.includes(":8888/playlet-invidious-backend")
      ) {
        url = invidiousInstance + url;
      } else {
        url = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      }
    }
    return url;
  } else if (invidiousInstance) {
    return `${invidiousInstance}/vi/${videoId || "--"}/mqdefault.jpg`;
  }
  return undefined;
}
