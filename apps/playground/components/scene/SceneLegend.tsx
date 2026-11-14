import { KIND_META } from "@/lib/scene-model";
import type { SceneNodeKind } from "@/store/playground";
import KindIcon from "./KindIcon";

/** What each kind of node in the scene is: its icon, its colour and a line of meaning. */
export default function SceneLegend({ kinds }: { kinds: readonly SceneNodeKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <ul aria-label="Legend" className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
      {kinds.map((kind) => (
        <li key={kind} className="flex items-start gap-1.5">
          <KindIcon kind={kind} className="mt-0.5 h-3 w-3" />
          <span>
            <span className="text-white/85">{KIND_META[kind].name}</span>
            <span className="text-subtle">: {KIND_META[kind].meaning}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
