import type { ReactElement } from "react";

export const BANNED_CLASSES = {
  destructive: "text-destructive",
  palette: "bg-emerald-400/10",
  paletteVariant: "hover:text-red-500",
  paletteOther: "border-sky-300",
  stellar: "bg-stellar",
  stellarModifier: "text-stellar/70",
  black: "text-black",
  remSize: "text-[0.7rem]",
  pxSize: "md:text-[11px]",
} as const;

export function BannedStyling({ size }: { size: string }): ReactElement {
  return (
    <div>
      <p className="text-destructive">destructive</p>
      <p className="bg-emerald-400/10 text-amber-400">palette</p>
      <button className="bg-stellar text-black">stellar fill</button>
      <span className={`text-[0.62rem] ${size}`}>arbitrary size</span>
    </div>
  );
}
