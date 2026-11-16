import React, { useLayoutEffect, useState } from 'react';

/** Tamaño en px de un elemento (ResizeObserver). */
export function useElementSize<T extends Element>(ref: React.RefObject<T | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 900, h: 560 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize((s) =>
          Math.abs(s.w - r.width) > 0.5 || Math.abs(s.h - r.height) > 0.5 ? { w: r.width, h: r.height } : s
        );
      }
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
