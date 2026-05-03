import type { Ace } from "ace-builds";

export interface LineWidget {
  row: number;
  el: HTMLElement;
  rowCount?: number;
  coverGutter?: boolean;
  fixedWidth?: boolean;
  className?: string;
  pixelHeight?: number;
  session?: Ace.EditSession;
  _inDocument?: boolean;
  $oldWidget?: LineWidget;
}

interface AceSessionInternals {
  lineWidgets?: Array<LineWidget | undefined>;
  _emit: (event: string, data: Record<string, unknown>) => void;
  widgetManager: WidgetManagerApi & {
    $updateRows: () => void;
    onWidgetChanged: (widget: LineWidget) => void;
  };
}

export interface RowEntry<TRef> {
  cacheKey: string;
  refKey: string;
  refs: TRef[];
  widget: LineWidget;
}

export interface WidgetManagerApi {
  addLineWidget: (w: LineWidget) => LineWidget;
  removeLineWidget: (w: LineWidget) => void;
}

export abstract class LineWidgetManager<TRef> {
  protected _editor: Ace.Editor;
  protected _rows: Map<number, RowEntry<TRef>> = new Map();
  private _syncPending = false;
  private _syncVersion = 0;
  protected _skipNextSync = false;

  constructor(editor: Ace.Editor) {
    this._editor = editor;
  }

  protected abstract _parseRefs(line: string): TRef[];
  protected abstract _refKey(refs: TRef[]): string;
  protected abstract _addRow(
    row: number,
    refs: TRef[],
    indent: number,
    syncVersion: number
  ): Promise<void>;
  protected _onDestroy(): void {}

  protected _isCurrentSync(syncVersion: number): boolean {
    return syncVersion === this._syncVersion;
  }

  protected _cacheKey(refs: TRef[], indent: number): string {
    return `${indent}|${this._refKey(refs)}`;
  }

  protected _lineIndent(line: string): number {
    let i = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    return i;
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
    const syncVersion = ++this._syncVersion;

    if (this._skipNextSync) {
      this._skipNextSync = false;
      return;
    }

    const session = this._editor.session;
    const lineCount = session.getLength();
    const desired = new Map<number, { refs: TRef[]; indent: number }>();

    for (let row = 0; row < lineCount; row++) {
      const line = session.getLine(row);
      const refs = this._parseRefs(line);
      if (refs.length > 0) {
        desired.set(row, { refs, indent: this._lineIndent(line) });
      }
    }

    const stale: Map<number, RowEntry<TRef>> = new Map();
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

    const recyclable = new Map<string, { mapKey: number; entry: RowEntry<TRef> }>();
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
        await this._addRow(row, refs, indent, syncVersion);
        if (!this._isCurrentSync(syncVersion)) {
          return;
        }
      }
    }
  }

  protected _recalcWidgetHeight(widget: LineWidget, container: HTMLElement) {
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

  private _relocateRow(oldMapKey: number, newRow: number, indent: number) {
    const entry = this._rows.get(oldMapKey);
    if (!entry) return;
    this._moveWidgetInPlace(entry.widget, newRow);
    if (indent > 0) {
      entry.widget.el.style.marginLeft = `${indent * this._editor.renderer.characterWidth}px`;
    } else {
      entry.widget.el.style.marginLeft = "";
    }
    this._rows.delete(oldMapKey);
    const line = this._editor.session.getLine(newRow);
    const refs = this._parseRefs(line);
    entry.cacheKey = this._cacheKey(refs, indent);
    entry.refKey = this._refKey(refs);
    entry.refs = refs;
    this._rows.set(newRow, entry);
  }

  private _moveWidgetInPlace(widget: LineWidget, newRow: number) {
    const oldRow = widget.row;
    if (oldRow === newRow) return;

    const session = this._editor.session as unknown as AceSessionInternals;
    const lineWidgets = session.lineWidgets;
    if (!lineWidgets) return;

    const headAtOld = lineWidgets[oldRow];
    if (headAtOld === widget) {
      lineWidgets[oldRow] = widget.$oldWidget;
    } else {
      let cur = headAtOld;
      while (cur) {
        if (cur.$oldWidget === widget) {
          cur.$oldWidget = widget.$oldWidget;
          break;
        }
        cur = cur.$oldWidget;
      }
    }

    const existing = lineWidgets[newRow];
    widget.$oldWidget = existing;
    lineWidgets[newRow] = widget;
    widget.row = newRow;

    session._emit("changeFold", { data: { start: { row: oldRow } } });
    session._emit("changeFold", { data: { start: { row: newRow } } });
    session.widgetManager.$updateRows();
    session.widgetManager.onWidgetChanged(widget);
  }

  private _removeRow(row: number) {
    const entry = this._rows.get(row);
    if (!entry) return;
    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.removeLineWidget(entry.widget);
    this._rows.delete(row);
  }

  protected _registerRow(row: number, refs: TRef[], indent: number, widget: LineWidget) {
    const wm = this._editor.session.widgetManager as WidgetManagerApi;
    wm.addLineWidget(widget);
    this._rows.set(row, {
      cacheKey: this._cacheKey(refs, indent),
      refKey: this._refKey(refs),
      refs,
      widget,
    });
  }

  clear() {
    this._syncVersion++;
    for (const row of [...this._rows.keys()]) {
      this._removeRow(row);
    }
  }

  destroy() {
    this.clear();
    this._onDestroy();
  }
}
