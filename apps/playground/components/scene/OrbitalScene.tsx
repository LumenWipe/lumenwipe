"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, MotionConfig, useReducedMotion } from "motion/react";
import { usePlaygroundStore } from "@/store/playground";
import {
  GUIDE_RINGS,
  legendKinds,
  nextFocusIndex,
  sceneOrder,
  sceneStill,
} from "@/lib/scene-model";
import OrbitalNode from "./OrbitalNode";
import CoreAccount from "./CoreAccount";
import SceneLegend from "./SceneLegend";
import SceneList from "./SceneList";

type SceneView = "orbit" | "list";

const TOGGLE =
  "min-h-6 rounded px-2 py-0.5 text-[11px] text-white/80 aria-pressed:bg-white/10 aria-pressed:text-white";

/**
 * The demo account and its entries. Motion is decided here, once: the visitor's reduced-motion
 * preference, the pause button, or a pointer or focus on a node stops the orbit, and MotionConfig
 * hands the preference to every animation below. The list view says the same as the orbit in text.
 */
export default function OrbitalScene() {
  const nodes = usePlaygroundStore((s) => s.nodes);
  const reduced = useReducedMotion() ?? false;
  const [view, setView] = useState<SceneView>("orbit");
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // The node holding the orbit's one tab stop and where it sat, so that when it is removed the
  // stop passes to the node that takes its place.
  const [active, setActive] = useState<{ id: string; index: number } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const orbitToggle = useRef<HTMLButtonElement>(null);

  const visible = useMemo(() => sceneOrder(nodes.filter((n) => n.status !== "destroyed")), [nodes]);
  const ids = visible.map((n) => n.id);
  const tabId =
    active && ids.includes(active.id)
      ? active.id
      : (ids[Math.min(active?.index ?? 0, ids.length - 1)] ?? null);
  const still = sceneStill(reduced, paused, hovered || focused);

  // When the focused node leaves the orbit, focus follows the tab stop, or goes to the view
  // toggle once no node is left.
  useEffect(() => {
    if (!focused) return;
    const target = tabId ? buttons.current.get(tabId) : orbitToggle.current;
    if (target && document.activeElement !== target) target.focus();
  }, [tabId, focused]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "Escape") {
      setExpandedId(null);
      return;
    }
    const next = nextFocusIndex(event.key, tabId ? ids.indexOf(tabId) : 0, ids.length);
    const id = next === null ? undefined : ids[next];
    if (next === null || id === undefined) return;
    event.preventDefault();
    setActive({ id, index: next });
    buttons.current.get(id)?.focus();
  };

  return (
    <MotionConfig reducedMotion="user">
      {nodes.length > 0 && (
        <div className="mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Scene view" className="flex gap-1">
              <button
                ref={orbitToggle}
                type="button"
                aria-pressed={view === "orbit"}
                onClick={() => setView("orbit")}
                className={TOGGLE}
              >
                Orbit
              </button>
              <button
                type="button"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
                className={TOGGLE}
              >
                List
              </button>
            </div>
            {view === "orbit" && !reduced && (
              <button
                type="button"
                aria-pressed={paused}
                onClick={() => setPaused((p) => !p)}
                className={TOGGLE}
              >
                Pause motion
              </button>
            )}
          </div>
          <SceneLegend kinds={legendKinds(nodes)} />
        </div>
      )}

      {view === "list" ? (
        <SceneList nodes={nodes} label="Entries on the demo account" />
      ) : (
        <div data-scene className="relative mx-auto aspect-square w-full max-w-[600px] select-none">
          {GUIDE_RINGS.map((f) => (
            <div
              key={f}
              aria-hidden
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.05]"
              style={{ width: `${f * 100}%`, height: `${f * 100}%` }}
            />
          ))}

          <CoreAccount still={still} />

          {nodes.length > 0 && (
            <ul
              aria-label="Entries on the demo account"
              className="absolute inset-0"
              onKeyDown={onKeyDown}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
              onFocus={() => setFocused(true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
              }}
            >
              <AnimatePresence>
                {visible.map((node, index) => (
                  <OrbitalNode
                    key={node.id}
                    node={node}
                    still={still}
                    tabStop={node.id === tabId}
                    expanded={node.id === expandedId}
                    onFocus={() => setActive({ id: node.id, index })}
                    onToggle={() => setExpandedId((e) => (e === node.id ? null : node.id))}
                    buttonRef={(el) => {
                      if (el) buttons.current.set(node.id, el);
                      else buttons.current.delete(node.id);
                    }}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
      )}
    </MotionConfig>
  );
}
