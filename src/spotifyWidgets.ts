import type { Ace } from "ace-builds";
import { LineWidgetManager, type LineWidget } from "./lineWidgets";

export const SPOTIFY_URL_REGEX =
  /https:\/\/open\.spotify\.com\/(track|album|artist|playlist|episode|show)\/([a-zA-Z0-9]+)[^\s]*/g;

interface SpotifyRef {
  url: string;
  type: string;
  id: string;
}

export function parseSpotifyUrls(line: string): SpotifyRef[] {
  const refs: SpotifyRef[] = [];
  const regex = new RegExp(SPOTIFY_URL_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    refs.push({ url: match[0], type: match[1], id: match[2] });
  }
  return refs;
}

export class SpotifyWidgetManager extends LineWidgetManager<SpotifyRef> {
  constructor(editor: Ace.Editor) {
    super(editor);
  }

  protected _parseRefs(line: string): SpotifyRef[] {
    return parseSpotifyUrls(line);
  }

  protected _refKey(refs: SpotifyRef[]): string {
    return refs.map((r) => `${r.type}:${r.id}`).join(",");
  }

  private _isBackgroundDark(): boolean {
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--note-background-color")
      .trim();
    if (!bg || !bg.startsWith("#")) return false;
    const hex = bg.replace("#", "");
    if (hex.length < 6) return false;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return r * 0.299 + g * 0.587 + b * 0.114 < 128;
  }

  protected async _addRow(row: number, refs: SpotifyRef[], indent: number, syncVersion: number) {
    const container = document.createElement("div");
    container.className = "spotify-widget";
    if (indent > 0) {
      container.style.marginLeft = `${indent * this._editor.renderer.characterWidth}px`;
    }

    const widget: LineWidget = {
      row,
      el: container,
      coverGutter: true,
      fixedWidth: true,
      className: "spotify-widget-container",
    };

    const isDark = this._isBackgroundDark();

    for (const ref of refs) {
      const embedUrl = `https://open.spotify.com/embed/${ref.type}/${ref.id}${isDark ? "?theme=0" : ""}`;

      const iframe = document.createElement("iframe");
      iframe.className = "spotify-embed";
      iframe.src = embedUrl;
      iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
      iframe.loading = "lazy";
      container.appendChild(iframe);
    }

    if (!this._isCurrentSync(syncVersion)) return;
    this._registerRow(row, refs, indent, widget);

    requestAnimationFrame(() => {
      this._recalcWidgetHeight(widget, container);
    });
  }
}
