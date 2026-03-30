import type { Ace } from "ace-builds";
import { getAsset, parseImageRefs } from "./assets";

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
  assetIds: string[];
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

  async sync() {
    const session = this._editor.session;
    const lineCount = session.getLength();
    const desired = new Map<number, string[]>();

    for (let row = 0; row < lineCount; row++) {
      const ids = parseImageRefs(session.getLine(row));
      if (ids.length > 0) {
        desired.set(row, ids);
      }
    }

    const toRemove: number[] = [];
    for (const [row, entry] of this._rows) {
      const desiredIds = desired.get(row);
      if (!desiredIds || desiredIds.join(",") !== entry.assetIds.join(",")) {
        toRemove.push(row);
      }
    }
    for (const row of toRemove) {
      this._removeRow(row);
    }

    for (const [row, ids] of desired) {
      if (!this._rows.has(row)) {
        await this._addRow(row, ids);
      }
    }
  }

  private async _addRow(row: number, assetIds: string[]) {
    const container = document.createElement("div");
    container.className = "image-widget";

    const objectUrls: string[] = [];

    for (const assetId of assetIds) {
      const asset = await getAsset(assetId);
      if (!asset) continue;

      const objectUrl = URL.createObjectURL(asset.blob);
      objectUrls.push(objectUrl);

      const wrapper = document.createElement("div");
      wrapper.className = "image-widget-thumb";

      const img = document.createElement("img");
      img.src = objectUrl;
      img.className = "image-widget-img";
      img.addEventListener("click", () => this._onSpotlight(objectUrl));

      const label = document.createElement("span");
      label.className = "image-widget-label";
      label.textContent = assetId;

      wrapper.appendChild(img);
      wrapper.appendChild(label);
      container.appendChild(wrapper);
    }

    if (objectUrls.length === 0) return;

    const widget: LineWidget = {
      row,
      el: container,
      coverGutter: true,
      fixedWidth: true,
      className: "image-widget-container",
    };

    const lastImg = container.querySelector("img");
    if (lastImg) {
      lastImg.addEventListener("load", () => {
        const lineHeight = this._editor.renderer.layerConfig.lineHeight;
        const rowCount = Math.ceil(container.offsetHeight / lineHeight) + 1;
        if (widget.rowCount !== rowCount) {
          widget.rowCount = rowCount;
          widget.pixelHeight = container.offsetHeight;
          const session = this._editor.session as Ace.EditSession & {
            _emit: (event: string, data: Record<string, unknown>) => void;
          };
          session._emit("changeFold", { data: { start: { row } } });
        }
      });
    }

    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.addLineWidget(widget);

    this._rows.set(row, { assetIds, objectUrls, widget });
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
