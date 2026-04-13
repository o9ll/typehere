import type { Ace } from "ace-builds";
import { getAsset, parseImageRefs, type ImageRef } from "./assets";
import { LineWidgetManager, type LineWidget } from "./lineWidgets";

const DEFAULT_MAX_WIDTH = 300;
const DEFAULT_MAX_HEIGHT = 200;
const MIN_RESIZE_WIDTH = 30;

type SpotlightCallback = (objectUrl: string) => void;

export class ImageWidgetManager extends LineWidgetManager<ImageRef> {
  private _urlCache: Map<string, string> = new Map();
  private _onSpotlight: SpotlightCallback;

  constructor(editor: Ace.Editor, onSpotlight: SpotlightCallback) {
    super(editor);
    this._onSpotlight = onSpotlight;
  }

  protected _parseRefs(line: string): ImageRef[] {
    return parseImageRefs(line);
  }

  protected _refKey(refs: ImageRef[]): string {
    return refs.map((r) => `${r.id}:${r.scale ?? ""}`).join(",");
  }

  private async _getObjectUrl(assetId: string): Promise<string | null> {
    const cached = this._urlCache.get(assetId);
    if (cached) return cached;
    const asset = await getAsset(assetId);
    if (!asset) return null;
    const url = URL.createObjectURL(asset.blob);
    this._urlCache.set(assetId, url);
    return url;
  }

  private _commitScale(widget: LineWidget, refId: string, newScale: number) {
    const session = this._editor.session;
    const line = session.getLine(widget.row);
    const rounded = Math.round(newScale * 100) / 100;
    const replacement = rounded === 1 ? `[img:${refId}]` : `[img:${refId}:${rounded}]`;
    const newLine = line.replace(
      new RegExp(`\\[img:${refId}(?::[\\d.]+)?\\]`),
      replacement
    );

    if (newLine === line) return;

    this._skipNextSync = true;
    session.replace(
      { start: { row: widget.row, column: 0 }, end: { row: widget.row, column: line.length } } as Ace.Range,
      newLine
    );
    const entry = this._rows.get(widget.row);
    if (entry) {
      const updatedRefs = parseImageRefs(newLine);
      entry.cacheKey = this._cacheKey(updatedRefs, this._lineIndent(newLine));
      entry.refKey = this._refKey(updatedRefs);
      entry.refs = updatedRefs;
    }
  }

  private _attachResizeHandle(
    img: HTMLImageElement,
    wrapper: HTMLElement,
    container: HTMLElement,
    widget: LineWidget,
    ref: ImageRef
  ) {
    const handle = document.createElement("div");
    handle.className = "image-widget-resize-handle";

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startWidth = img.offsetWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const newWidth = Math.max(MIN_RESIZE_WIDTH, startWidth + (ev.clientX - startX));
        img.style.maxWidth = `${newWidth}px`;
        img.style.maxHeight = "none";
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        const finalWidth = img.offsetWidth;
        const newScale = finalWidth / DEFAULT_MAX_WIDTH;
        this._commitScale(widget, ref.id, newScale);
        this._recalcWidgetHeight(widget, container);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    wrapper.appendChild(handle);
  }

  protected async _addRow(row: number, refs: ImageRef[], indent: number) {
    const container = document.createElement("div");
    container.className = "image-widget";
    if (indent > 0) {
      container.style.marginLeft = `${indent * this._editor.renderer.characterWidth}px`;
    }

    const widget: LineWidget = {
      row,
      el: container,
      coverGutter: true,
      fixedWidth: true,
      className: "image-widget-container",
    };

    let hasImages = false;
    for (const ref of refs) {
      const objectUrl = await this._getObjectUrl(ref.id);
      if (!objectUrl) continue;

      hasImages = true;

      const wrapper = document.createElement("div");
      wrapper.className = "image-widget-thumb";

      const img = document.createElement("img");
      img.src = objectUrl;
      img.className = "image-widget-img";
      if (ref.scale) {
        img.style.maxWidth = `${Math.round(DEFAULT_MAX_WIDTH * ref.scale)}px`;
        img.style.maxHeight = `${Math.round(DEFAULT_MAX_HEIGHT * ref.scale)}px`;
      }
      img.addEventListener("click", () => this._onSpotlight(objectUrl));

      const label = document.createElement("span");
      label.className = "image-widget-label";
      label.textContent = ref.id;

      wrapper.appendChild(img);
      wrapper.appendChild(label);
      this._attachResizeHandle(img, wrapper, container, widget, ref);
      container.appendChild(wrapper);
    }

    if (!hasImages) return;

    const lastImg = container.querySelector("img");
    if (lastImg) {
      lastImg.addEventListener("load", () => {
        this._recalcWidgetHeight(widget, container);
      });
    }

    this._registerRow(row, refs, indent, widget);
  }

  protected _onDestroy() {
    for (const url of this._urlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this._urlCache.clear();
  }
}
