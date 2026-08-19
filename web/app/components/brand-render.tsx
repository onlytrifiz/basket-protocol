"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

/**
 * A floating 3D brand render. Space is reserved by fixed CSS dimensions and an
 * intrinsically sized <Image>, so the parallax never contributes layout shift.
 * Marketing surfaces only — /docs and the data tables stay still.
 */
export function BrandRender({
  className,
  priority = false,
  size,
  src,
}: {
  className: string;
  priority?: boolean;
  size: number;
  src: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const centred = (box.top + box.height / 2) / window.innerHeight;
      element.style.setProperty("--parallax", `${((0.5 - centred) * 36).toFixed(2)}px`);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className={className} ref={ref}>
      <Image alt="" height={size} priority={priority} src={src} width={size} />
    </div>
  );
}
