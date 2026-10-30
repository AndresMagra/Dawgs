import { useRef, useState } from 'react';
import { PanResponder, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Button, P, Row } from './components';
import { radius, useTheme } from './theme';

/**
 * Draw-your-signature box. Produces an SVG path string, which is what the
 * API stores next to the typed name and the exact text signed.
 */
export function SignaturePad({ onChange }: { onChange: (path: string | null) => void }) {
  const t = useTheme();
  const [paths, setPaths] = useState<string[]>([]);
  const current = useRef('');
  const [live, setLive] = useState('');
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX: x, locationY: y } = e.nativeEvent;
        current.current = `M${x.toFixed(1)} ${y.toFixed(1)}`;
        setLive(current.current);
      },
      onPanResponderMove: (e) => {
        const { locationX: x, locationY: y } = e.nativeEvent;
        current.current += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
        setLive(current.current);
      },
      onPanResponderRelease: () => {
        const done = current.current;
        current.current = '';
        setLive('');
        setPaths((p) => {
          const next = [...p, done];
          onChange(next.join(' '));
          return next;
        });
      },
    }),
  ).current;
  return (
    <View style={{ gap: 6 }}>
      <View
        {...responder.panHandlers}
        style={{ height: 160, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}
      >
        <Svg width="100%" height="100%">
          {[...paths, live].filter(Boolean).map((d, i) => (
            <Path key={i} d={d} stroke={t.text} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </Svg>
      </View>
      <Row between>
        <P small muted>Sign with your finger or mouse</P>
        <Button
          small
          variant="ghost"
          title="Clear"
          onPress={() => {
            setPaths([]);
            onChange(null);
          }}
        />
      </Row>
    </View>
  );
}
