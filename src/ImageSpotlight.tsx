import React, { useEffect, useCallback, useState, useRef } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const WHEEL_SENSITIVITY = 0.005;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

interface ImageSpotlightProps {
  src: string;
  onClose: () => void;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

function ImageSpotlight({ src, onClose }: ImageSpotlightProps) {
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const transformRef = useRef<Transform>(IDENTITY);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const wheelRafRef = useRef(0);
  const wheelEndTimeoutRef = useRef(0);
  const wheelAccumRef = useRef<{ zoom: number; px: number; py: number; dx: number; dy: number }>({
    zoom: 0,
    px: 0,
    py: 0,
    dx: 0,
    dy: 0,
  });

  const commit = useCallback((next: Transform, animate: boolean) => {
    setIsAnimating(animate);
    setTransform(next);
    transformRef.current = next;
  }, []);

  useEffect(() => {
    commit(IDENTITY, false);
    setIsDragging(false);
    dragStartRef.current = null;
  }, [src, commit]);

  const zoomAt = useCallback(
    (factor: number, clientX: number, clientY: number, animate: boolean) => {
      const img = imgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const cx = clientX - (rect.left + rect.width / 2);
      const cy = clientY - (rect.top + rect.height / 2);
      const t = transformRef.current;
      const newScale = clampZoom(t.scale * factor);
      const r = newScale / t.scale;
      commit({ scale: newScale, tx: t.tx + cx - cx * r, ty: t.ty + cy - cy * r }, animate);
    },
    [commit]
  );

  useEffect(() => {
    const overlay = imgRef.current?.closest(".image-spotlight-overlay") as HTMLElement | null;
    if (!overlay) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        wheelAccumRef.current.zoom += e.deltaY;
        wheelAccumRef.current.px = e.clientX;
        wheelAccumRef.current.py = e.clientY;
      } else {
        wheelAccumRef.current.dx += e.deltaX;
        wheelAccumRef.current.dy += e.deltaY;
      }

      clearTimeout(wheelEndTimeoutRef.current);
      wheelEndTimeoutRef.current = window.setTimeout(() => {
        wheelAccumRef.current = { zoom: 0, px: 0, py: 0, dx: 0, dy: 0 };
      }, 150);

      if (!wheelRafRef.current) {
        wheelRafRef.current = requestAnimationFrame(() => {
          wheelRafRef.current = 0;
          const acc = wheelAccumRef.current;

          if (acc.zoom !== 0) {
            const factor = Math.exp(-acc.zoom * WHEEL_SENSITIVITY);
            const px = acc.px;
            const py = acc.py;
            acc.zoom = 0;
            const img = imgRef.current;
            if (img) {
              const rect = img.getBoundingClientRect();
              const cx = px - (rect.left + rect.width / 2);
              const cy = py - (rect.top + rect.height / 2);
              const t = transformRef.current;
              const newScale = clampZoom(t.scale * factor);
              const r = newScale / t.scale;
              const next = { scale: newScale, tx: t.tx + cx - cx * r, ty: t.ty + cy - cy * r };
              setIsAnimating(false);
              setTransform(next);
              transformRef.current = next;
            }
          }

          if (acc.dx !== 0 || acc.dy !== 0) {
            const dx = acc.dx;
            const dy = acc.dy;
            acc.dx = 0;
            acc.dy = 0;
            const t = transformRef.current;
            const next = { ...t, tx: t.tx - dx, ty: t.ty - dy };
            setIsAnimating(false);
            setTransform(next);
            transformRef.current = next;
          }
        });
      }
    };

    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      overlay.removeEventListener("wheel", onWheel);
      if (wheelRafRef.current) cancelAnimationFrame(wheelRafRef.current);
      clearTimeout(wheelEndTimeoutRef.current);
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        commit(IDENTITY, true);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        const img = imgRef.current;
        if (!img) return;
        const r = img.getBoundingClientRect();
        zoomAt(1 / ZOOM_STEP, r.left + r.width / 2, r.top + r.height / 2, true);
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        const img = imgRef.current;
        if (!img) return;
        const r = img.getBoundingClientRect();
        zoomAt(ZOOM_STEP, r.left + r.width / 2, r.top + r.height / 2, true);
        return;
      }
    },
    [onClose, commit, zoomAt]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleMouseDown = (e: MouseEvent<HTMLImageElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: transformRef.current.tx,
      ty: transformRef.current.ty,
    };
    setIsAnimating(false);
    setIsDragging(false);
  };

  useEffect(() => {
    const onMouseMove = (e: globalThis.MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!isDragging && Math.hypot(dx, dy) > 4) setIsDragging(true);
      const next = { ...transformRef.current, tx: start.tx + dx, ty: start.ty + dy };
      setTransform(next);
      transformRef.current = next;
    };
    const onMouseUp = () => {
      dragStartRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  const handleImageClick = (e: MouseEvent<HTMLImageElement>) => {
    e.stopPropagation();
    if (isDragging) return;
    zoomAt(e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP, e.clientX, e.clientY, true);
  };

  const handleOverlayClick = () => {
    if (isDragging) return;
    onClose();
  };

  const handleZoomOut = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    zoomAt(1 / ZOOM_STEP, r.left + r.width / 2, r.top + r.height / 2, true);
  };

  const handleZoomIn = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    zoomAt(ZOOM_STEP, r.left + r.width / 2, r.top + r.height / 2, true);
  };

  const handleReset = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    commit(IDENTITY, true);
  };

  const isIdentity = transform.scale === 1 && transform.tx === 0 && transform.ty === 0;
  const zoomLabel = isIdentity ? "—" : `${Math.round(transform.scale * 100)}%`;

  const imgStyle: React.CSSProperties = {
    transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
    transition: isAnimating ? "transform 0.18s ease" : "none",
    cursor: isDragging ? "grabbing" : "zoom-in",
  };

  return createPortal(
    <div className="image-spotlight-overlay" onClick={handleOverlayClick}>
      <div className="image-spotlight-stage">
        <img
          ref={imgRef}
          className="image-spotlight-img"
          src={src}
          style={imgStyle}
          onMouseDown={handleMouseDown}
          onClick={handleImageClick}
          onLoad={() => commit(IDENTITY, false)}
          alt=""
          draggable={false}
        />
      </div>
      <div
        className="image-spotlight-toolbar"
        onClick={(e) => e.stopPropagation()}
        role="toolbar"
        aria-label="Image zoom"
      >
        <button
          type="button"
          className="image-spotlight-tool-btn"
          onClick={handleZoomOut}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="image-spotlight-zoom-label" aria-live="polite">
          {zoomLabel}
        </span>
        <button
          type="button"
          className="image-spotlight-tool-btn"
          onClick={handleZoomIn}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="image-spotlight-tool-btn"
          onClick={handleReset}
          aria-label="Reset zoom"
        >
          Fit
        </button>
      </div>
    </div>,
    document.body
  );
}

export default ImageSpotlight;
