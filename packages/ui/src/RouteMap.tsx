import { View } from 'react-native';
import Svg, { Circle, Polyline, Rect } from 'react-native-svg';
import type { GpsPoint } from '@dawgs/client';
import { useTheme, radius } from './theme';

/**
 * The walk's route drawn from its GPS points, scaled to fit. Needs no map
 * provider or API key, so it works the same on the web, iPhone and Android;
 * a street map underneath can come later.
 */
export function RouteMap({ points, height = 220 }: { points: GpsPoint[]; height?: number }) {
  const t = useTheme();
  const W = 320;
  const H = 200;
  if (points.length === 0) {
    return <View style={{ height, borderRadius: radius.lg, backgroundColor: t.surface2 }} />;
  }
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = points.map((p) => p.lng * k);
  const ys = points.map((p) => p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1e-5);
  const pad = 16;
  const sx = (x: number) => pad + ((x - minX) / span) * (W - 2 * pad) + ((W - 2 * pad) - ((maxX - minX) / span) * (W - 2 * pad)) / 2;
  const sy = (y: number) => H - pad - ((y - minY) / span) * (H - 2 * pad) - ((H - 2 * pad) - ((maxY - minY) / span) * (H - 2 * pad)) / 2;
  const pts = points.map((p, i) => `${sx(xs[i]!)},${sy(ys[i]!)}`).join(' ');
  const last = points.length - 1;
  return (
    <View style={{ height, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: t.surface2 }}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <Rect x={0} y={0} width={W} height={H} fill={t.dark ? '#1f2a23' : '#e7efe4'} />
        <Polyline points={pts} fill="none" stroke={t.brand} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
        <Circle cx={sx(xs[0]!)} cy={sy(ys[0]!)} r={6} fill={t.ok} />
        <Circle cx={sx(xs[last]!)} cy={sy(ys[last]!)} r={7} fill={t.bad} stroke="#fff" strokeWidth={2} />
      </Svg>
    </View>
  );
}
