import type { PointerEventHandler, ReactNode, RefObject } from "react";

export function InteractivePreviewSurface({
  canvasRef, imageRef, image, alt, zoom, canvasClassName = "", stageClassName = "",
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onImageLoad, children,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  image: string;
  alt: string;
  zoom: number;
  canvasClassName?: string;
  stageClassName?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onImageLoad?: () => void;
  children?: ReactNode;
}) {
  return <div ref={canvasRef} className={`region-preview-canvas ${canvasClassName}`.trim()}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
    <div className={`region-preview-stage ${stageClassName}`.trim()} style={{ width: `${zoom * 100}%` }}>
      <img ref={imageRef} draggable={false} className="region-preview"
        src={`data:image/png;base64,${image}`} alt={alt} onLoad={onImageLoad} />
      {children}
    </div>
  </div>;
}
