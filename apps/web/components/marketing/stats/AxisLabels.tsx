export interface AxisLabel {
  label: string;
  /** Position in the chart's viewBox units. */
  x: number;
}

type Anchor = "start" | "middle" | "end";

const EDGE = 0.05;

const ANCHOR_CLASS: Record<Anchor, string> = {
  start: "translate-x-0",
  middle: "-translate-x-1/2",
  end: "-translate-x-full",
};

function anchorFor(fraction: number): Anchor {
  if (fraction < EDGE) return "start";
  if (fraction > 1 - EDGE) return "end";
  return "middle";
}

/**
 * Labels set in HTML under a chart drawn at `width` viewBox units across the same box, so they
 * keep the type scale at every width while staying at their marks' horizontal positions.
 */
export default function AxisLabels({
  labels,
  width,
}: {
  labels: readonly AxisLabel[];
  width: number;
}) {
  return (
    <div className="relative mb-2 h-4">
      {labels.map((l) => {
        const fraction = l.x / width;
        const anchor = anchorFor(fraction);
        return (
          <span
            key={l.label + l.x}
            data-axis-label
            data-anchor={anchor}
            className={`mkt-mono absolute top-0 whitespace-nowrap text-caption text-fg-subtle ${ANCHOR_CLASS[anchor]}`}
            style={{ left: `${fraction * 100}%` }}
          >
            {l.label}
          </span>
        );
      })}
    </div>
  );
}
