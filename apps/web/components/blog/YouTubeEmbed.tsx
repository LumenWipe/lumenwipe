"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";
import { videoEmbedUrl, videoPoster } from "@/lib/site/videos";
import { cn } from "@/lib/utils/cn";

/**
 * A video that loads YouTube's player only once the visitor presses play. Until then the page
 * shows a poster served from this site, and makes no request to YouTube.
 */
export default function YouTubeEmbed({
  id,
  title,
  className = "my-8 rounded-lg",
}: {
  id: string;
  title: string;
  className?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (playing) frame.current?.focus();
  }, [playing]);

  return (
    <div
      className={cn("relative aspect-video w-full overflow-hidden bg-surface-sunken", className)}
    >
      {playing ? (
        <iframe
          ref={frame}
          src={videoEmbedUrl(id)}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={BLOG[SITE_LOCALE].playVideo(title)}
          className="group absolute inset-0 h-full w-full focus-visible:-outline-offset-2"
        >
          {/* Pre-sized at 640x360 in public/, so the image optimizer has nothing to add. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={videoPoster(id)}
            alt=""
            width={640}
            height={360}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-canvas/85 text-fg ring-1 ring-line-strong transition-colors group-hover:bg-accent group-hover:text-accent-fg">
              <Play className="ml-0.5 h-6 w-6" />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
