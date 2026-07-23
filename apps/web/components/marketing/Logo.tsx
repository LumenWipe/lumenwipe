interface LogoProps {
  className?: string;
  showWord?: boolean;
}

/**
 * LumenWipe mark: a four-point Stellar "spark" with a sweep tail,
 * the account being cleanly wiped and its light recovered.
 */
export default function Logo({ className = "h-7 w-auto", showWord = true }: LogoProps) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" role="img">
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="8"
          stroke="hsl(var(--stellar))"
          strokeOpacity="0.35"
          strokeWidth="1.25"
        />
        {/* sweep arc */}
        <path
          d="M7 22c4.5 3 13.5 3 18 0"
          stroke="hsl(var(--value))"
          strokeOpacity="0.9"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* four-point spark */}
        <path
          d="M16 6.5c.7 4.2 2.3 5.8 6.5 6.5-4.2.7-5.8 2.3-6.5 6.5-.7-4.2-2.3-5.8-6.5-6.5 4.2-.7 5.8-2.3 6.5-6.5Z"
          fill="hsl(var(--stellar))"
        />
      </svg>
      {showWord && (
        <span className="mkt-display text-[1.05rem] font-bold tracking-tight text-white">
          Lumen<span className="text-stellar">Wipe</span>
        </span>
      )}
    </span>
  );
}
