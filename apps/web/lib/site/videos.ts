export interface Video {
  id: string;
  title: string;
  description: string;
  lang: "EN" | "ES";
  duration: string;
}

export const VIDEOS: readonly Video[] = [
  {
    id: "vD3xhPpqah8",
    title: "What is LumenWipe?",
    description:
      "A 3-minute overview of what LumenWipe does, why Stellar reserves get locked, and how the non-custodial close flow works.",
    lang: "EN",
    duration: "3 min",
  },
  {
    id: "nVS2zI9mRzw",
    title: "Full walkthrough: testnet, playground & mainnet",
    description:
      "An 11-minute demo covering the full close flow - from testnet dry run to a live mainnet account close.",
    lang: "EN",
    duration: "11 min",
  },
  {
    id: "eRkcNd9996c",
    title: "Demo completo: testnet, playground y mainnet",
    description:
      "Demo de 14 minutos que cubre el flujo completo: testnet, playground y cierre real en mainnet.",
    lang: "ES",
    duration: "14 min",
  },
];

export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** Served from this site, so a page shows the video without asking YouTube for anything. */
export function videoPoster(id: string): string {
  return `/video-posters/${id}.webp`;
}

export function videoEmbedUrl(id: string): string {
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${encodeURIComponent(id)}?autoplay=1`;
}
