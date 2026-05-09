# Design System — bullmq-dash

## Product Context

- **What this is:** Terminal UI dashboard for BullMQ queue monitoring
- **Who it's for:** Backend developers, DevOps, SREs managing background job queues
- **Space/industry:** Developer tools, queue monitoring
- **Project type:** Terminal/TUI application (CLI)

## Aesthetic Direction

- **Direction:** Brutally Minimal — Type and whitespace only
- **Decoration level:** Minimal — let data be the UI
- **Mood:** Fast, focused, scannable. No decoration. Just data.
- **Reference:** Terminal-native tools (htop, bpytop, lazydocker)

## Typography

- **Display/Hero:** JetBrains Mono — 18px bold for queue names
- **Body:** JetBrains Mono — 13px for data rows
- **UI/Labels:** JetBrains Mono — 11px for status indicators
- **Data/Tables:** JetBrains Mono — 12px tabular-nums for job counts
- **Code:** JetBrains Mono
- **Loading:** System monospace fallback, JetBrains Mono from Google Fonts
- **Scale:**
  - hero: 18px / 600
  - body: 13px / 400
  - small: 11px / 400
  - tiny: 10px / 400

## Color

- **Approach:** Balanced — color as signal, not decoration

### Status Colors

| State     | Hex              | Usage                   |
| --------- | ---------------- | ----------------------- |
| waiting   | #f9e2af (yellow) | Jobs awaiting execution |
| active    | #89b4fa (blue)   | Currently processing    |
| completed | #a6e3a1 (green)  | Successfully finished   |
| failed    | #f38ba8 (red)    | Error/exception state   |
| delayed   | #cba6f7 (mauve)  | Scheduled for future    |

### Catppuccin Mocha Palette

| Role       | Hex     | Name     |
| ---------- | ------- | -------- |
| background | #1e1e2e | base     |
| panel bg   | #45475a | surface1 |
| selected   | #6c7086 | overlay0 |
| text       | #cdd6f4 | text     |
| muted      | #a6adc8 | subtext0 |
| secondary  | #89b4fa | blue     |
| success    | #a6e3a1 | green    |
| warning    | #f9e2af | yellow   |
| error      | #f38ba8 | red      |

### Light Mode (optional)

Invert saturation by 10-20%:

- base → #eff1f5
- surface0 → #ccd0da
- Reduce saturation 10-20% on all colors

## Spacing

- **Base unit:** 8px
- **Density:** Comfortable — prioritize readability over density
- **Scale:**
  - xs: 4px (inline elements)
  - sm: 8px (default gaps)
  - md: 16px (panel padding)
  - lg: 24px (section gaps)
  - xl: 32px (major sections)

## Layout

- **Approach:** Grid-disciplined — predictable column alignment
- **Grid:** Flexible based on terminal width
- **Max content width:** terminal width - 2 (padding)
- **Border radius:** 4px (subtle softening)
- **Line height:** 1.5 (readable data rows)

## Motion

- **Approach:** None — polling-based updates only
- **Rationale:** Terminal UIs shouldn't animate. Data updates on poll interval.

## Visual Hierarchy (Updated)

- Panel backgrounds: surface1 (#45475a)
- Selected row: overlay0 (#6c7086)
- Data text: base text (#cdd6f4)
- Muted labels: subtext0 (#a6adc8)
- More breathing room: lg gaps between sections, md padding on panels

## Decisions Log

| Date       | Decision              | Rationale                                                                     |
| ---------- | --------------------- | ----------------------------------------------------------------------------- |
| 2026-04-26 | Initial design system | Created by /design-consultation — brutalist, monospace-only, Catppuccin Mocha |
