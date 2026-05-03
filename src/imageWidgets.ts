import type { Ace } from "ace-builds";
import { getAsset, parseImageRefs, type ImageRef } from "./assets";
import { LineWidgetManager, type LineWidget } from "./lineWidgets";

const DEFAULT_MAX_WIDTH = 300;
const DEFAULT_MAX_HEIGHT = 200;
const MIN_RESIZE_WIDTH = 30;

export type ImageSpotlightOpenPayload = {
  urls: string[];
  index: number;
};

type SpotlightCallback = (payload: ImageSpotlightOpenPayload) => void;

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

  private _attachImageWidgetChrome(
    scrollEl: HTMLElement,
    shell: HTMLElement,
    widget: LineWidget
  ): () => void {
    const fadeLeft = document.createElement("button");
    fadeLeft.type = "button";
    fadeLeft.className = "image-widget-fade image-widget-fade-left";
    fadeLeft.setAttribute("aria-label", "Scroll images left");
    const fadeRight = document.createElement("button");
    fadeRight.type = "button";
    fadeRight.className = "image-widget-fade image-widget-fade-right";
    fadeRight.setAttribute("aria-label", "Scroll images right");

    shell.appendChild(fadeLeft);
    shell.appendChild(fadeRight);

    const scrollEndEps = 2;

    const scrollNudge = (direction: -1 | 1) => {
      const w = scrollEl.clientWidth;
      const distance = Math.max(64, Math.min(180, Math.floor(w * 0.4)));
      scrollEl.scrollBy({ left: direction * distance, behavior: "smooth" });
    };

    const scrollToStart = () => {
      scrollEl.scrollTo({ left: 0, behavior: "smooth" });
    };

    const scrollToEnd = () => {
      const maxLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      scrollEl.scrollTo({ left: maxLeft, behavior: "smooth" });
    };

    const isModifierJump = (e: MouseEvent) => e.metaKey || e.ctrlKey;

    const onPointerFade = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    fadeLeft.addEventListener("mousedown", onPointerFade);
    fadeRight.addEventListener("mousedown", onPointerFade);
    fadeLeft.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierJump(e)) {
        scrollToStart();
      } else {
        scrollNudge(-1);
      }
    });
    fadeRight.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierJump(e)) {
        scrollToEnd();
      } else {
        scrollNudge(1);
      }
    });

    const sync = () => {
      if (!scrollEl.isConnected) {
        return;
      }
      const { scrollLeft, scrollWidth, clientWidth } = scrollEl;
      const isOverflowing = scrollWidth > clientWidth + scrollEndEps;
      shell.classList.toggle("isScrollable", isOverflowing);
      if (!isOverflowing) {
        fadeLeft.classList.remove("isVisible");
        fadeRight.classList.remove("isVisible");
        fadeLeft.disabled = true;
        fadeRight.disabled = true;
        return;
      }
      const isAtStart = scrollLeft <= scrollEndEps;
      const isAtEnd = scrollLeft + clientWidth >= scrollWidth - scrollEndEps;
      fadeLeft.classList.toggle("isVisible", !isAtStart);
      fadeRight.classList.toggle("isVisible", !isAtEnd);
      fadeLeft.disabled = isAtStart;
      fadeRight.disabled = isAtEnd;
    };

    scrollEl.addEventListener("scroll", sync, { passive: true });

    const ro = new ResizeObserver(() => {
      if (!scrollEl.isConnected) {
        ro.disconnect();
        return;
      }
      sync();
      this._recalcWidgetHeight(widget, scrollEl);
    });
    ro.observe(scrollEl);

    requestAnimationFrame(() => {
      sync();
      this._recalcWidgetHeight(widget, scrollEl);
    });

    return sync;
  }

  private _attachResizeHandle(
    img: HTMLImageElement,
    wrapper: HTMLElement,
    container: HTMLElement,
    widget: LineWidget,
    ref: ImageRef,
    onLayout: () => void
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
        onLayout();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    wrapper.appendChild(handle);
  }

  protected async _addRow(row: number, refs: ImageRef[], indent: number, syncVersion: number) {
    const shell = document.createElement("div");
    shell.className = "image-widget";
    if (indent > 0) {
      shell.style.marginLeft = `${indent * this._editor.renderer.characterWidth}px`;
    }

    const scrollEl = document.createElement("div");
    scrollEl.className = "image-widget-scroll";
    shell.appendChild(scrollEl);

    const widget: LineWidget = {
      row,
      el: shell,
      coverGutter: true,
      fixedWidth: true,
      className: "image-widget-container",
    };

    let syncScrollChrome: () => void = () => {};

    const rowObjectUrls: string[] = [];
    let hasImages = false;
    for (const ref of refs) {
      const objectUrl = await this._getObjectUrl(ref.id);
      if (!this._isCurrentSync(syncVersion)) return;
      if (!objectUrl) continue;

      hasImages = true;
      const indexInRow = rowObjectUrls.length;
      rowObjectUrls.push(objectUrl);

      const wrapper = document.createElement("div");
      wrapper.className = "image-widget-thumb";

      const img = document.createElement("img");
      img.src = objectUrl;
      img.className = "image-widget-img";
      if (ref.scale) {
        img.style.maxWidth = `${Math.round(DEFAULT_MAX_WIDTH * ref.scale)}px`;
        img.style.maxHeight = `${Math.round(DEFAULT_MAX_HEIGHT * ref.scale)}px`;
      }
      img.addEventListener("click", () => {
        this._onSpotlight({ urls: rowObjectUrls.slice(), index: indexInRow });
      });

      const label = document.createElement("span");
      label.className = "image-widget-label";
      label.textContent = ref.id;

      wrapper.appendChild(img);
      wrapper.appendChild(label);
      this._attachResizeHandle(img, wrapper, scrollEl, widget, ref, () => {
        this._recalcWidgetHeight(widget, scrollEl);
        syncScrollChrome();
      });
      scrollEl.appendChild(wrapper);
    }

    if (!this._isCurrentSync(syncVersion)) return;
    if (!hasImages) return;

    syncScrollChrome = this._attachImageWidgetChrome(scrollEl, shell, widget);

    const onImageLayout = () => {
      this._recalcWidgetHeight(widget, scrollEl);
      syncScrollChrome();
    };
    for (const img of scrollEl.querySelectorAll("img")) {
      const el = img as HTMLImageElement;
      el.addEventListener("load", onImageLayout);
      if (el.complete) {
        onImageLayout();
      }
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
