import type { CSSProperties } from "react";

type AppRegionStyle = CSSProperties & {
  WebkitAppRegion: "drag" | "no-drag";
};

const DRAG_REGION_STYLE: AppRegionStyle = {
  WebkitAppRegion: "drag",
};

const NO_DRAG_STYLE: AppRegionStyle = {
  WebkitAppRegion: "no-drag",
};

export function DesktopCornerBrand() {
  return (
    <div
      style={DRAG_REGION_STYLE}
      className="pointer-events-none absolute left-0 top-0 z-20 flex h-[44px] w-16 items-center justify-center pt-1.5"
    >
      <div style={NO_DRAG_STYLE} className="pointer-events-auto flex items-center justify-center">
        <img
          src="/favicon.png"
          alt="Gym Motion"
          className="h-6 w-6 select-none object-contain"
          draggable={false}
        />
      </div>
    </div>
  );
}
