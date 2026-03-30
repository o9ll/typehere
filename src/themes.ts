type Theme = {
  id: string;
  name: string;
  isDark: boolean;
  accentColor: string;
};

const THEMES: Theme[] = [
  { id: "light", name: "Light", isDark: false, accentColor: "#666666" },
  { id: "paper", name: "Paper", isDark: false, accentColor: "#7a6e61" },
  { id: "sepia", name: "Sepia", isDark: false, accentColor: "#7a6b57" },
  { id: "nord-light", name: "Nord Light", isDark: false, accentColor: "#616e88" },
  { id: "solarized-light", name: "Solarized Light", isDark: false, accentColor: "#839496" },
  { id: "rose-pine-dawn", name: "Rose Pine Dawn", isDark: false, accentColor: "#797593" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", isDark: false, accentColor: "#7287fd" },
  { id: "dark", name: "Dark", isDark: true, accentColor: "#cccccc" },
  { id: "nord", name: "Nord", isDark: true, accentColor: "#81a1c1" },
  { id: "dracula", name: "Dracula", isDark: true, accentColor: "#bd93f9" },
  { id: "gruvbox", name: "Gruvbox", isDark: true, accentColor: "#a89984" },
  { id: "tokyo-night", name: "Tokyo Night", isDark: true, accentColor: "#7aa2f7" },
  { id: "rose-pine", name: "Rose Pine", isDark: true, accentColor: "#c4a7e7" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", isDark: true, accentColor: "#89b4fa" },
  { id: "solarized-dark", name: "Solarized Dark", isDark: true, accentColor: "#2aa198" },
  { id: "one-dark", name: "One Dark", isDark: true, accentColor: "#61afef" },
  { id: "everforest", name: "Everforest", isDark: true, accentColor: "#a7c080" },
  { id: "monokai", name: "Monokai", isDark: true, accentColor: "#a6e22e" },
  { id: "kanagawa", name: "Kanagawa", isDark: true, accentColor: "#7e9cd8" },
  { id: "github-dark", name: "GitHub Dark", isDark: true, accentColor: "#58a6ff" },
];

function applyThemeToDocument(theme: Theme, isPreview = false): void {
  document.documentElement.setAttribute("data-theme", theme.id);

  if (!isPreview) {
    try {
      localStorage.setItem("typehere-theme-cache", theme.id);
    } catch {}
  }
}

function restoreThemeFromCache(): boolean {
  try {
    const cached = localStorage.getItem("typehere-theme-cache");
    if (!cached) return false;

    if (cached.startsWith("{")) {
      const parsed = JSON.parse(cached) as { id: string };
      if (parsed.id) {
        localStorage.setItem("typehere-theme-cache", parsed.id);
        document.documentElement.setAttribute("data-theme", parsed.id);
        return true;
      }
      return false;
    }

    document.documentElement.setAttribute("data-theme", cached);
    return true;
  } catch {
    return false;
  }
}

function getThemeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export type { Theme };
export { THEMES, applyThemeToDocument, restoreThemeFromCache, getThemeById };
