type SignalStrengthMeterProps = {
  value: number | null;
  className?: string;
};

export function SignalStrengthMeter({
  value,
  className = "",
}: SignalStrengthMeterProps) {
  return (
    <div
      className={`group flex items-center gap-1.5 cursor-help ${className}`.trim()}
      title={value === null ? "Signal unavailable" : `Signal: ${value}% (${value >= 75 ? "Excellent" : value >= 50 ? "Good" : value >= 25 ? "Fair" : "Weak"})`}
    >
      <div className="flex gap-0.5">
        {[1, 2, 3, 4].map((bar) => (
          <div
            key={bar}
            className={`w-0.5 rounded-full transition-[colors,transform] group-hover:-translate-y-px ${
              value !== null && bar <= Math.ceil(value / 25)
                ? "bg-blue-400"
                : "bg-zinc-700"
            }`}
            style={{ height: `${bar * 3 + 4}px`, transitionDelay: `${(bar - 1) * 50}ms` }}
          />
        ))}
      </div>
      <span className="text-xs text-zinc-500 font-mono">
        {value === null ? "--" : `${value}%`}
      </span>
    </div>
  );
}
