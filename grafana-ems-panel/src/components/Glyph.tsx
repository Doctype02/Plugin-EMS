import React from 'react';

/** Íconos de línea propios (24 × 24, trazo 1.8) para eventos, acciones y guía. Sin emojis. */
export type GlyphName =
  | 'fire'
  | 'bolt'
  | 'fan'
  | 'wrench'
  | 'door'
  | 'thermometer'
  | 'sun'
  | 'users'
  | 'trend'
  | 'snow'
  | 'leaf'
  | 'moon'
  | 'clock'
  | 'building'
  | 'sliders'
  | 'alert'
  | 'cursor';

const P: Record<GlyphName, React.ReactNode> = {
  fire: <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.7 2.3-5 .2 1.6 1 2.6 2.2 3 .3-3-.5-5.5.5-8Z" />,
  bolt: <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />,
  fan: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 10.4c-.5-2.6.3-4.6 2.4-5 1.8-.3 2.6 1.5 1.4 3-1 1.2-2.4 1.6-3.8 2ZM13.6 12.5c2.5.9 3.9 2.5 3.3 4.5-.5 1.7-2.5 1.8-3.3.1-.6-1.4-.4-2.9 0-4.6ZM10.6 12.9c-2 1.7-4.1 2-5.4.5-1.2-1.4-.1-3 1.8-2.8 1.5.2 2.6 1.1 3.6 2.3Z" />
    </>
  ),
  wrench: (
    <path d="M14.5 4.5a4.5 4.5 0 0 0-5.6 5.8L3.5 15.7a1.8 1.8 0 0 0 2.5 2.5l5.4-5.4a4.5 4.5 0 0 0 5.8-5.6l-2.7 2.7-2.4-.4-.4-2.4 2.8-2.6Z" />
  ),
  door: (
    <>
      <path d="M4 21h16M6 21V3h9v18" />
      <path d="M15 5l4 1.5V21" />
      <circle cx="12.5" cy="12" r=".6" fill="currentColor" />
    </>
  ),
  thermometer: (
    <>
      <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z" />
      <path d="M12 9v7" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c.6-3.4 3-5.3 6-5.3s5.4 1.9 6 5.3" />
      <path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.9c1.9.6 3.1 2.3 3.5 5.1" />
    </>
  ),
  trend: (
    <>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </>
  ),
  snow: <path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9.5 3.8 12 6l2.5-2.2M9.5 20.2 12 18l2.5 2.2" />,
  leaf: (
    <>
      <path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15" />
      <path d="M5 19c3-4 6-6.5 10-8.5" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5l8-2v18M12 7l8 2v12M2 21h20" />
      <path d="M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2" />
    </>
  ),
  sliders: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4" />,
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4.5M12 17.3v.2" />
    </>
  ),
  cursor: <path d="M5 3l14 7-6 1.8L10.5 18 5 3Z" />,
};

interface Props {
  name: GlyphName;
  size?: number;
  color?: string;
  className?: string;
  /** Posición dentro de un SVG padre (los íconos se pueden anidar en la escena). */
  x?: number;
  y?: number;
  title?: string;
}

export const Glyph: React.FC<Props> = ({ name, size = 16, color = 'currentColor', className, x, y, title }) => (
  <svg
    x={x}
    y={y}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ color, flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : undefined}
  >
    {title && <title>{title}</title>}
    {P[name]}
  </svg>
);
