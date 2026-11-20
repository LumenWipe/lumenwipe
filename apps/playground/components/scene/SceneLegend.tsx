import { KIND_META } from "@/lib/scene-model";
import type { SceneNodeKind } from "@/store/playground";
import KindIcon from "./KindIcon";

/** What each kind of node in the scene is: its icon, its colour and a line of meaning. On a phone
 *  the names wrap as one compact key, so the orbit stays near the top; the meanings are still read
 *  out, and show from sm up. */
export default function SceneLegend({ kinds }: { kinds: readonly SceneNodeKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <ul
      aria-label="Legend"
      className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] sm:grid sm:grid-cols-2 sm:gap-x-4"
    >
      {kinds.map((kind) => (
        <li key={kind} className="flex items-start gap-1.5">
          <KindIcon kind={kind} className="mt-0.5 h-3 w-3" />
          <span>
            <span className="text-white/85">{KIND_META[kind].name}</span>
            <span className="sr-only text-subtle sm:not-sr-only">: {KIND_META[kind].meaning}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
