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
  refKey: string;
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
  private _urlCache: Map<string, string> = new Map();
  private _onSpotlight: SpotlightCallback;
  private _syncPending = false;
  private _skipNextSync = false;

  constructor(editor: Ace.Editor, onSpotlight: SpotlightCallback) {
    this._editor = editor;
    this._onSpotlight = onSpotlight;
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

  scheduleSync() {
    if (this._syncPending) return;
    this._syncPending = true;
    requestAnimationFrame(() => {
      this._syncPending = false;
      this.sync();
    });
  }

  private _refKey(refs: ImageRef[]): string {
    return refs.map((r) => `${r.id}:${r.scale ?? ""}`).join(",");
  }

  private _cacheKey(refs: ImageRef[], indent: number): string {
    return `${indent}|${this._refKey(refs)}`;
  }

  private _lineIndent(line: string): number {
    let i = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    return i;
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

    const stale: Map<number, RowEntry> = new Map();
    for (const [row, entry] of this._rows) {
      const d = desired.get(row);
      if (!d || this._cacheKey(d.refs, d.indent) !== entry.cacheKey || entry.widget.row !== row) {
        stale.set(row, entry);
      }
    }

    const pending: number[] = [];
    for (const [row] of desired) {
      if (!this._rows.has(row) || stale.has(row)) {
        pending.push(row);
      }
    }

    const recyclable = new Map<string, { mapKey: number; entry: RowEntry }>();
    for (const [mapKey, entry] of stale) {
      recyclable.set(entry.refKey, { mapKey, entry });
    }

    for (const row of pending) {
      const d = desired.get(row)!;
      const rk = this._refKey(d.refs);
      const donor = recyclable.get(rk);
      if (donor) {
        this._relocateRow(donor.mapKey, row, d.indent);
        stale.delete(donor.mapKey);
        recyclable.delete(rk);
      }
    }

    for (const mapKey of stale.keys()) {
      this._removeRow(mapKey);
    }

    for (const [row, { refs, indent }] of desired) {
      if (!this._rows.has(row)) {
        await this._addRow(row, refs, indent);
      }
    }
  }

  private _recalcWidgetHeight(widget: LineWidget, container: HTMLElement) {
    const lineHeight = this._editor.renderer.layerConfig.lineHeight;
    const rowCount = Math.ceil(container.offsetHeight / lineHeight);
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
      const updatedRefs = parseImageRefs(newLine);
      entry.cacheKey = this._cacheKey(updatedRefs, this._lineIndent(newLine));
      entry.refKey = this._refKey(updatedRefs);
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

  private _relocateRow(oldMapKey: number, newRow: number, indent: number) {
    const entry = this._rows.get(oldMapKey);
    if (!entry) return;
    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.removeLineWidget(entry.widget);
    entry.widget.row = newRow;
    if (indent > 0) {
      entry.widget.el.style.marginLeft = `${indent * this._editor.renderer.characterWidth}px`;
    } else {
      entry.widget.el.style.marginLeft = "";
    }
    wm.addLineWidget(entry.widget);
    this._rows.delete(oldMapKey);
    const line = this._editor.session.getLine(newRow);
    const refs = parseImageRefs(line);
    entry.cacheKey = this._cacheKey(refs, indent);
    entry.refKey = this._refKey(refs);
    this._rows.set(newRow, entry);
  }

  private async _addRow(row: number, refs: ImageRef[], indent: number) {
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

    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.addLineWidget(widget);

    this._rows.set(row, { cacheKey: this._cacheKey(refs, indent), refKey: this._refKey(refs), widget });
  }

  private _removeRow(row: number) {
    const entry = this._rows.get(row);
    if (!entry) return;
    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.removeLineWidget(entry.widget);
    this._rows.delete(row);
  }

  clear() {
    for (const row of [...this._rows.keys()]) {
      this._removeRow(row);
    }
  }

  destroy() {
    this.clear();
    for (const url of this._urlCache.values()) {
      URL.revokeObjectURL(url);
    }
    this._urlCache.clear();
  }
}
