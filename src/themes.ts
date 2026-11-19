export interface Theme {
  id: string;
  background: string;
  title: string;
  text: string;
  muted: string;
  accent: string;
  /** Fill behind code, quotes and table headers. */
  surface: string;
  border: string;
  highlight: string;
}

export const THEMES = {
  light: {
    id: 'light',
    background: 'FFFFFF',
    title: '0F172A',
    text: '334155',
    muted: '64748B',
    accent: '2563EB',
    surface: 'F1F5F9',
    border: 'E2E8F0',
    highlight: 'FEF08A',
  },
  paper: {
    id: 'paper',
    background: 'FFFDF5',
    title: '40577D',
    text: '334155',
    muted: '857F6B',
    accent: 'B45309',
    surface: 'F6F0DF',
    border: 'E8DFC6',
    highlight: 'FDE68A',
  },
  dark: {
    id: 'dark',
    background: '111827',
    title: 'F9FAFB',
    text: 'D1D5DB',
    muted: '9CA3AF',
    accent: '60A5FA',
    surface: '1F2937',
    border: '374151',
    highlight: '854D0E',
  },
  violet: {
    id: 'violet',
    background: '1E1B2E',
    title: 'F5F3FF',
    text: 'D9D6EA',
    muted: 'A39FBD',
    accent: 'A78BFA',
    surface: '2A2640',
    border: '3D3759',
    highlight: '6D28D9',
  },
} satisfies Record<string, Theme>;

export type ThemeId = keyof typeof THEMES;
