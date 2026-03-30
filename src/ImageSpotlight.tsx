import { useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface ImageSpotlightProps {
  src: string;
  onClose: () => void;
}

function ImageSpotlight({ src, onClose }: ImageSpotlightProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div className="image-spotlight-overlay" onClick={onClose}>
      <img
        className="image-spotlight-img"
        src={src}
        onClick={(e) => e.stopPropagation()}
        alt=""
      />
    </div>,
    document.body
  );
}

export default ImageSpotlight;
