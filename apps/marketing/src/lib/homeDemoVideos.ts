import { pickMostVisibleDemo } from "./demoPlayback";

export function initDemoVideos() {
  const videos = Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-demo-video]"));

  if (videos.length === 0) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const visibility = new Map<HTMLVideoElement, number>();

  const preloadVideos = () => {
    videos.forEach((video) => {
      if (video.src) return;
      const source = video.dataset.src;

      if (source) video.src = source;
    });
  };

  const updatePlayback = () => {
    if (document.hidden || reduceMotion) {
      videos.forEach((video) => video.pause());

      return;
    }

    const activeIndex = pickMostVisibleDemo(videos.map((video) => visibility.get(video) ?? 0));

    videos.forEach((video, index) => {
      if (index === activeIndex) void video.play().catch(() => undefined);
      else video.pause();
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const video = entry.target as HTMLVideoElement;
        visibility.set(video, entry.intersectionRatio);
      });
      updatePlayback();
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1] },
  );

  videos.forEach((video) => observer.observe(video));
  document.addEventListener("visibilitychange", updatePlayback);

  if (document.readyState === "complete") preloadVideos();
  else window.addEventListener("load", preloadVideos, { once: true });
}
