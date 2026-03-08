export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Background */}
      <rect width="32" height="32" rx="8" fill="url(#grad)" />

      {/* "10" text */}
      <text
        x="7"
        y="15.5"
        fontSize="11"
        fontWeight="800"
        fontFamily="system-ui, sans-serif"
        fill="white"
        letterSpacing="-0.5"
      >
        10
      </text>

      {/* "x" symbol — multiplication/times */}
      <text
        x="8"
        y="25"
        fontSize="9"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="rgba(255,255,255,0.85)"
        letterSpacing="0.5"
      >
        x DEV
      </text>

      {/* Speed lines */}
      <line x1="2" y1="28" x2="6" y2="28" stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeLinecap="round" />
      <line x1="1" y1="30" x2="4" y2="30" stroke="rgba(255,255,255,0.25)" strokeWidth="1" strokeLinecap="round" />

      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LogoFull({ height = 24 }: { height?: number }) {
  const w = height * 4;
  return (
    <svg
      width={w}
      height={height}
      viewBox="0 0 120 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Icon */}
      <rect width="28" height="28" rx="7" y="1" fill="url(#gradFull)" />
      <text x="5.5" y="14" fontSize="10" fontWeight="800" fontFamily="system-ui, sans-serif" fill="white" letterSpacing="-0.5">10</text>
      <text x="6" y="23" fontSize="7.5" fontWeight="700" fontFamily="system-ui, sans-serif" fill="rgba(255,255,255,0.85)">x DEV</text>

      {/* Text */}
      <text x="34" y="20" fontSize="15" fontWeight="700" fontFamily="system-ui, sans-serif" fill="currentColor">
        10TimesDev
      </text>

      <defs>
        <linearGradient id="gradFull" x1="0" y1="0" x2="28" y2="28">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
    </svg>
  );
}
