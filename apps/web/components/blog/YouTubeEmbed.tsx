export default function YouTubeEmbed({ id, title }: { id: string; title: string }) {
  return (
    <div
      className="relative my-8 w-full overflow-hidden rounded-lg"
      style={{ paddingBottom: "56.25%" }}
    >
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${id}`}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        loading="lazy"
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  );
}
