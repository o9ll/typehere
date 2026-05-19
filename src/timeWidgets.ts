import type { Ace } from "ace-builds";

const DATE_TIME_REGEX =
  /^(\s*)(\d{1,2})\/(\d{1,2})\/(\d{2})(?:\s+(?:mon|tue|wed|thur|thu|fri|sat|sun))?\s+(\d{1,2}):(\d{2})(am|pm|a|p)\b/i;

const SVG_NS = "http://www.w3.org/2000/svg";

interface TimeMatch {
  startCol: number;
  endCol: number;
  timeFraction: number;
  date: Date;
  dayOfYear: number;
  daysInYear: number;
  yearFraction: number;
}

interface MatchedRow extends TimeMatch {
  row: number;
  contentKey: string;
}

interface PositionedWidget {
  el: HTMLElement;
  skyEl: SVGSVGElement;
  match: TimeMatch;
  row: number;
  endCol: number;
  contentKey: string;
  onEnter: () => void;
  onLeave: () => void;
}

interface AceLayerConfig {
  lineHeight: number;
  characterWidth: number;
  firstRowScreen: number;
}

interface AceRendererInternals {
  $padding: number;
  content: HTMLElement;
  layerConfig: AceLayerConfig;
  characterWidth: number;
  on(event: "afterRender", fn: () => void): void;
  off(event: "afterRender", fn: () => void): void;
}

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function timeToDayFraction(
  hourStr: string,
  minuteStr: string,
  period: string
): number | null {
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 1 || hour > 12) return null;
  if (minute < 0 || minute > 59) return null;
  const isAm = period.toLowerCase().startsWith("a");
  let hour24: number;
  if (isAm) {
    hour24 = hour === 12 ? 0 : hour;
  } else {
    hour24 = hour === 12 ? 12 : hour + 12;
  }
  return (hour24 * 60 + minute) / (24 * 60);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function findTimeMatches(line: string): TimeMatch[] {
  const m = DATE_TIME_REGEX.exec(line);
  if (m === null) return [];
  const leadingWhitespace = m[1] ?? "";
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const yearTwoDigit = parseInt(m[4], 10);
  const timeFraction = timeToDayFraction(m[5], m[6], m[7]);
  if (timeFraction === null) return [];
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(yearTwoDigit)) {
    return [];
  }
  const fullYear = 2000 + yearTwoDigit;
  const minutesIntoDay = Math.round(timeFraction * 24 * 60);
  const hourOfDay = Math.floor(minutesIntoDay / 60);
  const minuteOfHour = minutesIntoDay % 60;
  const date = new Date(fullYear, month - 1, day, hourOfDay, minuteOfHour);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return [];

  const yearStart = new Date(fullYear, 0, 1);
  const dayOfYear =
    Math.floor((date.getTime() - yearStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const daysInYear = isLeapYear(fullYear) ? 366 : 365;
  const yearFraction = (dayOfYear - 1 + timeFraction) / daysInYear;

  return [
    {
      startCol: leadingWhitespace.length,
      endCol: m[0].length,
      timeFraction,
      date,
      dayOfYear,
      daysInYear,
      yearFraction,
    },
  ];
}

function widgetKey(row: number, startCol: number, endCol: number): string {
  return `${row}:${startCol}:${endCol}`;
}

type Rgb = readonly [number, number, number];

const SKY_TOP_STOPS: ReadonlyArray<{ t: number; color: Rgb }> = [
  { t: 0.0, color: [10, 14, 36] },
  { t: 0.22, color: [22, 28, 70] },
  { t: 0.27, color: [86, 70, 122] },
  { t: 0.32, color: [120, 130, 178] },
  { t: 0.42, color: [148, 188, 228] },
  { t: 0.5, color: [126, 178, 224] },
  { t: 0.58, color: [148, 188, 228] },
  { t: 0.68, color: [200, 160, 198] },
  { t: 0.73, color: [120, 90, 138] },
  { t: 0.78, color: [30, 36, 78] },
  { t: 1.0, color: [10, 14, 36] },
];

const SKY_BOTTOM_STOPS: ReadonlyArray<{ t: number; color: Rgb }> = [
  { t: 0.0, color: [18, 22, 50] },
  { t: 0.22, color: [54, 48, 88] },
  { t: 0.27, color: [220, 138, 100] },
  { t: 0.32, color: [248, 196, 132] },
  { t: 0.42, color: [218, 226, 232] },
  { t: 0.5, color: [206, 224, 236] },
  { t: 0.58, color: [232, 220, 200] },
  { t: 0.68, color: [248, 158, 88] },
  { t: 0.73, color: [212, 96, 72] },
  { t: 0.78, color: [56, 36, 70] },
  { t: 1.0, color: [18, 22, 50] },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function rgbString(c: Rgb): string {
  return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

function sampleStops(
  stops: ReadonlyArray<{ t: number; color: Rgb }>,
  t: number
): Rgb {
  const clamped = clampUnit(t);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (clamped >= a.t && clamped <= b.t) {
      const span = b.t - a.t;
      const localT = span === 0 ? 0 : (clamped - a.t) / span;
      return lerpColor(a.color, b.color, localT);
    }
  }
  return stops[stops.length - 1].color;
}

function setSvgAttrs(el: SVGElement, attrs: Record<string, string | number>) {
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
}

interface StarSeed {
  x: number;
  y: number;
  r: number;
  a: number;
}

const STAR_SEEDS: ReadonlyArray<StarSeed> = [
  { x: 5, y: 3.5, r: 0.38, a: 0.85 },
  { x: 11, y: 6, r: 0.3, a: 0.65 },
  { x: 16, y: 2.6, r: 0.42, a: 0.95 },
  { x: 22, y: 4.8, r: 0.32, a: 0.7 },
  { x: 28, y: 3.2, r: 0.38, a: 0.8 },
  { x: 33, y: 6.4, r: 0.3, a: 0.6 },
  { x: 39, y: 3.8, r: 0.34, a: 0.75 },
];

function sunAltitude(timeFraction: number): number {
  return Math.sin(2 * Math.PI * (timeFraction - 0.25));
}

function buildSkyScene(timeFraction: number): SVGSVGElement {
  const w = 44;
  const h = 16;
  const padX = 3;
  const innerW = w - 2 * padX;
  const midY = h / 2;
  const amplitude = midY - 1.8;

  const altitude = sunAltitude(timeFraction);
  const isDay = altitude > 0;
  const bodyX = padX + timeFraction * innerW;
  const bodyY = midY - altitude * amplitude;

  const topColor = sampleStops(SKY_TOP_STOPS, timeFraction);
  const bottomColor = sampleStops(SKY_BOTTOM_STOPS, timeFraction);

  const svg = document.createElementNS(SVG_NS, "svg");
  setSvgAttrs(svg, { viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  svg.classList.add("time-widget-sky");

  const gradientId = `time-widget-sky-grad-${Math.random().toString(36).slice(2, 9)}`;
  const defs = document.createElementNS(SVG_NS, "defs");
  const gradient = document.createElementNS(SVG_NS, "linearGradient");
  setSvgAttrs(gradient, { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
  const stopTop = document.createElementNS(SVG_NS, "stop");
  setSvgAttrs(stopTop, { offset: "0%", "stop-color": rgbString(topColor) });
  const stopBottom = document.createElementNS(SVG_NS, "stop");
  setSvgAttrs(stopBottom, { offset: "100%", "stop-color": rgbString(bottomColor) });
  gradient.appendChild(stopTop);
  gradient.appendChild(stopBottom);
  defs.appendChild(gradient);
  svg.appendChild(defs);

  const bg = document.createElementNS(SVG_NS, "rect");
  setSvgAttrs(bg, {
    x: 0,
    y: 0,
    width: w,
    height: h,
    rx: 2.5,
    ry: 2.5,
    fill: `url(#${gradientId})`,
  });
  svg.appendChild(bg);

  const arcPathPoints: string[] = [];
  const arcSamples = 22;
  for (let i = 0; i <= arcSamples; i++) {
    const ti = i / arcSamples;
    const ax = padX + ti * innerW;
    const ay = midY - sunAltitude(ti) * amplitude;
    arcPathPoints.push(`${i === 0 ? "M" : "L"} ${ax.toFixed(2)} ${ay.toFixed(2)}`);
  }
  const arc = document.createElementNS(SVG_NS, "path");
  setSvgAttrs(arc, {
    d: arcPathPoints.join(" "),
    stroke: "rgba(255, 255, 255, 0.18)",
    "stroke-width": 0.5,
    "stroke-dasharray": "1 1.2",
    fill: "none",
  });
  svg.appendChild(arc);

  const darkness = clampUnit(-altitude * 1.4);
  if (darkness > 0.15) {
    for (const star of STAR_SEEDS) {
      const dot = document.createElementNS(SVG_NS, "circle");
      setSvgAttrs(dot, {
        cx: star.x,
        cy: star.y,
        r: star.r,
        fill: "#ffffff",
        opacity: (star.a * darkness).toFixed(2),
      });
      svg.appendChild(dot);
    }
  }

  if (isDay) {
    const glow = document.createElementNS(SVG_NS, "circle");
    setSvgAttrs(glow, {
      cx: bodyX,
      cy: bodyY,
      r: 3.4,
      fill: "#ffe4a3",
      opacity: 0.32,
    });
    svg.appendChild(glow);
  }

  const body = document.createElementNS(SVG_NS, "circle");
  setSvgAttrs(body, {
    cx: bodyX,
    cy: bodyY,
    r: 1.6,
    fill: isDay ? "#ffd56b" : "#7e8094",
    opacity: isDay ? 1 : 0.55,
  });
  svg.appendChild(body);

  return svg;
}

const MONTHS_SHORT = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

const WEEKDAYS_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function formatTooltipDate(date: Date): string {
  const weekday = WEEKDAYS_SHORT[date.getDay()];
  const month = MONTHS_SHORT[date.getMonth()];
  return `${weekday} ${month} ${date.getDate()}, ${date.getFullYear()}`;
}

function formatTooltipTime(date: Date): string {
  const hour = date.getHours();
  const minute = date.getMinutes().toString().padStart(2, "0");
  const period = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minute} ${period}`;
}

function buildYearBar(yearFraction: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "time-widget-tooltip-year";

  const marker = document.createElement("div");
  marker.className = "time-widget-tooltip-year-marker";
  marker.style.left = `${(yearFraction * 100).toFixed(2)}%`;
  bar.appendChild(marker);

  return bar;
}

function buildTooltipContent(match: TimeMatch): HTMLElement {
  const tooltip = document.createElement("div");
  tooltip.className = "time-widget-tooltip";

  const headline = document.createElement("div");
  headline.className = "time-widget-tooltip-headline";
  headline.textContent = `${formatTooltipDate(match.date)} · ${formatTooltipTime(match.date)}`;
  tooltip.appendChild(headline);

  tooltip.appendChild(buildYearBar(match.yearFraction));

  const footer = document.createElement("div");
  footer.className = "time-widget-tooltip-footer";
  const leftLabel = document.createElement("span");
  leftLabel.textContent = `day ${match.dayOfYear} of ${match.daysInYear}`;
  const rightLabel = document.createElement("span");
  rightLabel.textContent = `${Math.round(match.yearFraction * 100)}%`;
  footer.appendChild(leftLabel);
  footer.appendChild(rightLabel);
  tooltip.appendChild(footer);

  return tooltip;
}

export class TimeWidgetManager {
  private _editor: Ace.Editor;
  private _layer: HTMLDivElement;
  private _widgets: Map<string, PositionedWidget> = new Map();
  private _isSyncPending = false;
  private _onAfterRender: () => void;
  private _onChange: () => void;
  private _tooltipHost: HTMLDivElement;
  private _activeWidget: PositionedWidget | null = null;
  private _onWindowResize: () => void;

  constructor(editor: Ace.Editor) {
    this._editor = editor;
    const renderer = editor.renderer as never as AceRendererInternals;

    this._layer = document.createElement("div");
    this._layer.className = "time-widget-layer";
    renderer.content.appendChild(this._layer);

    this._tooltipHost = document.createElement("div");
    this._tooltipHost.className = "time-widget-tooltip-host";
    document.body.appendChild(this._tooltipHost);

    this._onAfterRender = () => {
      this._repositionAll();
      if (this._activeWidget) {
        this._positionTooltip(this._activeWidget);
      }
    };
    renderer.on("afterRender", this._onAfterRender);

    this._onChange = () => this.scheduleSync();
    editor.session.on("change", this._onChange);

    this._onWindowResize = () => {
      if (this._activeWidget) {
        this._positionTooltip(this._activeWidget);
      }
    };
    window.addEventListener("resize", this._onWindowResize);
  }

  private _showTooltip(widget: PositionedWidget) {
    this._activeWidget = widget;
    this._tooltipHost.replaceChildren(buildTooltipContent(widget.match));
    this._tooltipHost.classList.add("isVisible");
    this._positionTooltip(widget);
  }

  private _hideTooltip(widget: PositionedWidget) {
    if (this._activeWidget !== widget) return;
    this._activeWidget = null;
    this._tooltipHost.classList.remove("isVisible");
  }

  private _positionTooltip(widget: PositionedWidget) {
    const skyRect = widget.skyEl.getBoundingClientRect();
    const tooltipRect = this._tooltipHost.getBoundingClientRect();
    const margin = 6;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = skyRect.left + skyRect.width / 2 - tooltipRect.width / 2;
    left = Math.max(margin, Math.min(left, viewportWidth - tooltipRect.width - margin));

    const aboveTop = skyRect.top - tooltipRect.height - margin;
    const belowTop = skyRect.bottom + margin;
    let top: number;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + tooltipRect.height <= viewportHeight - margin) {
      top = belowTop;
    } else {
      top = Math.max(margin, viewportHeight - tooltipRect.height - margin);
    }

    this._tooltipHost.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  scheduleSync() {
    if (this._isSyncPending) return;
    this._isSyncPending = true;
    requestAnimationFrame(() => {
      this._isSyncPending = false;
      this.sync();
    });
  }

  reset() {
    this.clear();
    this.scheduleSync();
  }

  sync() {
    const session = this._editor.session;
    const lineCount = session.getLength();
    const desired = new Map<string, MatchedRow>();

    for (let row = 0; row < lineCount; row++) {
      const line = session.getLine(row);
      const matches = findTimeMatches(line);
      for (const m of matches) {
        const key = widgetKey(row, m.startCol, m.endCol);
        const contentKey = line.slice(m.startCol, m.endCol);
        desired.set(key, { ...m, row, contentKey });
      }
    }

    for (const [key, widget] of this._widgets) {
      const d = desired.get(key);
      if (!d || d.contentKey !== widget.contentKey) {
        this._disposeWidget(widget);
        this._widgets.delete(key);
      }
    }

    for (const [key, d] of desired) {
      if (this._widgets.has(key)) continue;
      this._widgets.set(key, this._createWidget(d));
    }

    this._repositionAll();
  }

  private _createWidget(match: MatchedRow): PositionedWidget {
    const el = document.createElement("span");
    el.className = "time-widget";
    const skyEl = buildSkyScene(match.timeFraction);
    el.appendChild(skyEl);
    this._layer.appendChild(el);

    const positioned: PositionedWidget = {
      el,
      skyEl,
      match,
      row: match.row,
      endCol: match.endCol,
      contentKey: match.contentKey,
      onEnter: () => this._showTooltip(positioned),
      onLeave: () => this._hideTooltip(positioned),
    };
    skyEl.addEventListener("mouseenter", positioned.onEnter);
    skyEl.addEventListener("mouseleave", positioned.onLeave);
    return positioned;
  }

  private _disposeWidget(widget: PositionedWidget) {
    widget.skyEl.removeEventListener("mouseenter", widget.onEnter);
    widget.skyEl.removeEventListener("mouseleave", widget.onLeave);
    if (this._activeWidget === widget) {
      this._hideTooltip(widget);
    }
    widget.el.remove();
  }

  private _repositionAll() {
    const editor = this._editor;
    const renderer = editor.renderer as never as AceRendererInternals;
    const session = editor.session;
    const config = renderer.layerConfig;
    const lineHeight = config.lineHeight;
    const charWidth = renderer.characterWidth;
    const padding = renderer.$padding ?? 0;
    const firstRowScreen = config.firstRowScreen;

    for (const widget of this._widgets.values()) {
      const screenPos = session.documentToScreenPosition(
        widget.row,
        widget.endCol
      );
      const top = (screenPos.row - firstRowScreen) * lineHeight;
      const left = padding + screenPos.column * charWidth;
      widget.el.style.transform = `translate(${left}px, ${top}px)`;
      widget.el.style.setProperty("--time-widget-line-height", `${lineHeight}px`);
    }
  }

  clear() {
    for (const widget of this._widgets.values()) {
      widget.skyEl.removeEventListener("mouseenter", widget.onEnter);
      widget.skyEl.removeEventListener("mouseleave", widget.onLeave);
    }
    this._widgets.clear();
    this._activeWidget = null;
    this._tooltipHost.classList.remove("isVisible");
    this._layer.replaceChildren();
  }

  destroy() {
    const renderer = this._editor.renderer as never as AceRendererInternals;
    renderer.off("afterRender", this._onAfterRender);
    this._editor.session.off("change", this._onChange);
    window.removeEventListener("resize", this._onWindowResize);
    this.clear();
    this._layer.remove();
    this._tooltipHost.remove();
  }
}
