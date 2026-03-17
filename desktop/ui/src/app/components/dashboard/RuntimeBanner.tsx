type RuntimeBannerProps = {
  runtimeState: "starting" | "running" | "degraded" | "restarting" | null | undefined;
};

export function RuntimeBanner({ runtimeState }: RuntimeBannerProps) {
  if (runtimeState !== "restarting") {
    return null;
  }

  return (
    <div className="max-w-[1800px] mx-auto mb-4 rounded-xl border border-blue-500/20 bg-blue-500/8 px-4 py-3 text-sm text-blue-300">
      Restarting gateway runtime. Keeping the last known device state on screen until the bridge reconnects.
    </div>
  );
}
