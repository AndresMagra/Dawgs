import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  brand: string;
  brandText: string;
  ok: string;
  okBg: string;
  warn: string;
  warnBg: string;
  bad: string;
  badBg: string;
  info: string;
  infoBg: string;
}

function build(dark: boolean, brand: string): Theme {
  return dark
    ? {
        dark,
        bg: '#111412',
        surface: '#1b1f1c',
        surface2: '#242a26',
        border: '#2f3632',
        text: '#eef2ef',
        muted: '#9aa59e',
        brand: lighten(brand),
        brandText: '#0d130f',
        ok: '#6fd39a',
        okBg: '#173326',
        warn: '#f0c060',
        warnBg: '#3a2f14',
        bad: '#ff8a80',
        badBg: '#3d1d1a',
        info: '#8cc4ff',
        infoBg: '#172a3d',
      }
    : {
        dark,
        bg: '#f5f6f2',
        surface: '#ffffff',
        surface2: '#eef0ea',
        border: '#dde1d8',
        text: '#18201b',
        muted: '#5f6b63',
        brand,
        brandText: '#ffffff',
        ok: '#1d7a4a',
        okBg: '#e2f4ea',
        warn: '#8a5a00',
        warnBg: '#fdf1d6',
        bad: '#b3261e',
        badBg: '#fbe4e2',
        info: '#1f5fa8',
        infoBg: '#e3eefb',
      };
}

/** A brand colour bright enough to read on a dark background. */
function lighten(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.45);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const Ctx = createContext<Theme>(build(false, '#2f6f4f'));

export function ThemeProvider({ brand, children }: { brand?: string | null; children: ReactNode }) {
  const scheme = useColorScheme();
  const theme = useMemo(() => build(scheme === 'dark', brand ?? '#2f6f4f'), [scheme, brand]);
  return <Ctx.Provider value={theme}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };
