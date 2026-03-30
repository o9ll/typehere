import type { Ace } from "ace-builds";
import { getAsset, parseImageRefs, type ImageRef } from "./assets";

const DEFAULT_MAX_WIDTH = 300;
const DEFAULT_MAX_HEIGHT = 200;
const MIN_RESIZE_WIDTH = 30;

interface LineWidget {
  row: number;
  el: HTMLElement;
  rowCount?: number;
  coverGutter?: boolean;
  fixedWidth?: boolean;
  className?: string;
  pixelHeight?: number;
  session?: Ace.EditSession;
  _inDocument?: boolean;
}

interface RowEntry {
  cacheKey: string;
  objectUrls: string[];
  widget: LineWidget;
}

interface WidgetManagerApi {
  addLineWidget: (w: LineWidget) => LineWidget;
  removeLineWidget: (w: LineWidget) => void;
}

type SpotlightCallback = (objectUrl: string) => void;

export class ImageWidgetManager {
  private _editor: Ace.Editor;
  private _rows: Map<number, RowEntry> = new Map();
  private _onSpotlight: SpotlightCallback;
  private _syncPending = false;
  private _skipNextSync = false;

  constructor(editor: Ace.Editor, onSpotlight: SpotlightCallback) {
    this._editor = editor;
    this._onSpotlight = onSpotlight;
  }

  scheduleSync() {
    if (this._syncPending) return;
    this._syncPending = true;
    requestAnimationFrame(() => {
      this._syncPending = false;
      this.sync();
    });
  }

  private _cacheKey(refs: ImageRef[], indent: number): string {
    const refPart = refs.map((r) => `${r.id}:${r.scale ?? ""}`).join(",");
    return `${indent}|${refPart}`;
  }

  private _lineIndent(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  async sync() {
    if (this._skipNextSync) {
      this._skipNextSync = false;
      return;
    }

    const session = this._editor.session;
    const lineCount = session.getLength();
    const desired = new Map<number, { refs: ImageRef[]; indent: number }>();

    for (let row = 0; row < lineCount; row++) {
      const line = session.getLine(row);
      const refs = parseImageRefs(line);
      if (refs.length > 0) {
        desired.set(row, { refs, indent: this._lineIndent(line) });
      }
    }

    const toRemove: number[] = [];
    for (const [row, entry] of this._rows) {
      const d = desired.get(row);
      if (!d || this._cacheKey(d.refs, d.indent) !== entry.cacheKey) {
        toRemove.push(row);
      }
    }
    for (const row of toRemove) {
      this._removeRow(row);
    }

    for (const [row, { refs, indent }] of desired) {
      if (!this._rows.has(row)) {
        await this._addRow(row, refs, indent);
      }
    }
  }

  private _recalcWidgetHeight(widget: LineWidget, container: HTMLElement) {
    const lineHeight = this._editor.renderer.layerConfig.lineHeight;
    const rowCount = Math.ceil(container.offsetHeight / lineHeight) + 1;
    if (widget.rowCount !== rowCount) {
      widget.rowCount = rowCount;
      widget.pixelHeight = container.offsetHeight;
      const session = this._editor.session as Ace.EditSession & {
        _emit: (event: string, data: Record<string, unknown>) => void;
      };
      session._emit("changeFold", { data: { start: { row: widget.row } } });
    }
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
      entry.cacheKey = this._cacheKey(parseImageRefs(newLine), this._lineIndent(newLine));
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

  private async _addRow(row: number, refs: ImageRef[], indent: number) {
    const container = document.createElement("div");
    container.className = "image-widget";
    if (indent > 0) {
      container.style.marginLeft = `${indent * this._editor.renderer.characterWidth}px`;
    }

    const objectUrls: string[] = [];

    const widget: LineWidget = {
      row,
      el: container,
      coverGutter: true,
      fixedWidth: true,
      className: "image-widget-container",
    };

    for (const ref of refs) {
      const asset = await getAsset(ref.id);
      if (!asset) continue;

      const objectUrl = URL.createObjectURL(asset.blob);
      objectUrls.push(objectUrl);

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

    if (objectUrls.length === 0) return;

    const lastImg = container.querySelector("img");
    if (lastImg) {
      lastImg.addEventListener("load", () => {
        this._recalcWidgetHeight(widget, container);
      });
    }

    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.addLineWidget(widget);

    this._rows.set(row, { cacheKey: this._cacheKey(refs, indent), objectUrls, widget });
  }

  private _removeRow(row: number) {
    const entry = this._rows.get(row);
    if (!entry) return;
    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.removeLineWidget(entry.widget);
    for (const url of entry.objectUrls) {
      URL.revokeObjectURL(url);
    }
    this._rows.delete(row);
  }

  clear() {
    for (const row of [...this._rows.keys()]) {
      this._removeRow(row);
    }
  }

  destroy() {
    this.clear();
  }
}
