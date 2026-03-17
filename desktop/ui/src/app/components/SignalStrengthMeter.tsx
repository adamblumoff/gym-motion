type SignalStrengthMeterProps = {
  value: number | null;
  className?: string;
};

export function SignalStrengthMeter({
  value,
  className = "",
}: SignalStrengthMeterProps) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`.trim()}>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4].map((bar) => (
          <div
            key={bar}
            className={`w-0.5 rounded-full transition-colors ${
              value !== null && bar <= Math.ceil(value / 25)
                ? "bg-blue-400"
                : "bg-zinc-700"
            }`}
            style={{ height: `${bar * 3 + 4}px` }}
          />
        ))}
      </div>
      <span className="text-xs text-zinc-500 font-mono">
        {value === null ? "--" : `${value}%`}
      </span>
    </div>
  );
}
