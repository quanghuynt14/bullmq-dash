/**
 * Catppuccin Mocha color palette
 * Shared across all UI components for consistency
 */
export const colors = {
  // Base colors
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",

  // Surface colors
  surface0: "#313244",
  surface1: "#45475a",

  // Overlay colors
  overlay0: "#6c7086",
  overlay1: "#7f849c",

  // Text colors
  subtext0: "#a6adc8",
  text: "#cdd6f4",

  // Accent colors
  lavender: "#b4befe",
  blue: "#89b4fa",
  sky: "#89dceb",
  teal: "#94e2d5",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  red: "#f38ba8",
  mauve: "#cba6f7",
} as const;

export type ColorName = keyof typeof colors;
