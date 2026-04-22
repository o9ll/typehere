import { evaluate, number } from "mathjs";

const SAFE_MATH_TOKEN = /^[0-9eE+*/^().%+\s-]+$/;

function hasBinaryOrUnaryContext(raw: string): boolean {
  const t = raw.replace(/[0-9.]+/g, "");
  if (/[()^*/%]/.test(t)) return true;
  return /[+\-]/.test(t);
}

function stripToMathTokens(raw: string): string {
  return raw
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/,/g, "")
    .replace(/[$~]/g, "")
    .replace(/\s+/g, "");
}

function formatValueForNote(n: number): string {
  if (!Number.isFinite(n)) {
    return "";
  }
  if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9) {
    return String(Math.round(n));
  }
  const t = n.toFixed(10);
  return t.replace(/\.?0+$/, "");
}

function resultWithDecorators(resultText: string, hasDollar: boolean, hasTilde: boolean): string {
  if (hasDollar && hasTilde) {
    return ` ~$${resultText}`;
  }
  if (hasDollar) {
    return ` $${resultText}`;
  }
  if (hasTilde) {
    return ` ~${resultText}`;
  }
  return ` ${resultText}`;
}

export function tryBuildInlineEqualSuffix(lineUpToAndIncludingEqual: string): string | null {
  if (lineUpToAndIncludingEqual.length < 2) {
    return null;
  }
  if (!lineUpToAndIncludingEqual.endsWith("=")) {
    return null;
  }
  if (lineUpToAndIncludingEqual.endsWith("==")) {
    return null;
  }
  const rawExpr = lineUpToAndIncludingEqual.slice(0, -1).trim();
  if (!rawExpr || rawExpr.includes("=")) {
    return null;
  }
  const hasDollar = rawExpr.includes("$");
  const hasTilde = rawExpr.includes("~");
  const stripped = stripToMathTokens(rawExpr);
  if (!stripped) {
    return null;
  }
  if (!hasBinaryOrUnaryContext(stripped)) {
    return null;
  }
  if (!SAFE_MATH_TOKEN.test(stripped)) {
    return null;
  }
  let value: number;
  try {
    value = number(evaluate(stripped));
  } catch {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const formatted = formatValueForNote(value);
  if (!formatted) {
    return null;
  }
  return resultWithDecorators(formatted, hasDollar, hasTilde);
}
