import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, useTheme } from './theme';

export function Screen({ children, scroll = true, padded = true, refreshing }: { children: ReactNode; scroll?: boolean; padded?: boolean; refreshing?: boolean }) {
  const t = useTheme();
  const inner = <View style={[{ padding: padded ? space.lg : 0, gap: space.lg, width: '100%', maxWidth: 1100, alignSelf: 'center' }]}>{children}</View>;
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {refreshing ? <ActivityIndicator style={{ position: 'absolute', top: 8, alignSelf: 'center', zIndex: 2 }} color={t.brand} /> : null}
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">{inner}</ScrollView> : inner}
    </View>
  );
}

export function H1({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ fontSize: 26, fontWeight: '700', color: t.text, letterSpacing: -0.3 }}>{children}</Text>;
}

export function H2({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
      <Text style={{ fontSize: 18, fontWeight: '700', color: t.text }}>{children}</Text>
      {right}
    </View>
  );
}

export function P({ children, muted, small, bold, style, numberOfLines, onPress }: { children: ReactNode; muted?: boolean; small?: boolean; bold?: boolean; style?: object; numberOfLines?: number; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Text numberOfLines={numberOfLines} onPress={onPress} suppressHighlighting style={[{ color: muted ? t.muted : t.text, fontSize: small ? 13 : 15, lineHeight: small ? 18 : 21, fontWeight: bold ? '600' : '400' }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const t = useTheme();
  const s = [{ backgroundColor: t.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, padding: space.lg, gap: space.sm }, style];
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => [s, pressed && { opacity: 0.85 }]} accessibilityRole="button">
      {children}
    </Pressable>
  ) : (
    <View style={s}>{children}</View>
  );
}

export function Row({ children, gap = space.sm, wrap, style, between }: { children: ReactNode; gap?: number; wrap?: boolean; style?: StyleProp<ViewStyle>; between?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap', justifyContent: between ? 'space-between' : 'flex-start' }, style]}>{children}</View>;
}

/** Columns that wrap into a single column on a phone. */
export function Grid({ children, min = 300 }: { children: ReactNode; min?: number }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.lg }}>{Array.isArray(children) ? children.map((c, i) => <View key={i} style={{ flexGrow: 1, flexBasis: min, minWidth: 0 }}>{c}</View>) : <View style={{ flexGrow: 1, flexBasis: min }}>{children}</View>}</View>;
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ title, onPress, variant = 'secondary', disabled, busy, small, icon }: { title: string; onPress?: () => void | Promise<unknown>; variant?: Variant; disabled?: boolean; busy?: boolean; small?: boolean; icon?: string }) {
  const t = useTheme();
  const [working, setWorking] = useState(false);
  const bg = variant === 'primary' ? t.brand : variant === 'danger' ? t.bad : variant === 'ghost' ? 'transparent' : t.surface2;
  const fg = variant === 'primary' ? t.brandText : variant === 'danger' ? '#fff' : variant === 'ghost' ? t.brand : t.text;
  const off = disabled || busy || working;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={off}
      onPress={async () => {
        if (!onPress) return;
        setWorking(true);
        try {
          await onPress();
        } finally {
          setWorking(false);
        }
      }}
      style={({ pressed }) => ({
        backgroundColor: bg,
        opacity: off ? 0.5 : pressed ? 0.8 : 1,
        borderRadius: radius.md,
        paddingVertical: small ? 6 : 11,
        paddingHorizontal: small ? 10 : 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
        minHeight: small ? 32 : 44,
      })}
    >
      {busy || working ? <ActivityIndicator size="small" color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: '600', fontSize: small ? 13 : 15 }}>
        {icon ? `${icon}  ` : ''}
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4, flexGrow: 1 }}>
      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        accessibilityLabel={label}
        {...props}
        style={[
          { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, color: t.text, fontSize: 16, minHeight: 44 },
          props.multiline ? { minHeight: 90, textAlignVertical: 'top' } : null,
          props.style,
        ]}
      />
      {hint ? <Text style={{ color: t.muted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <Row between>
      {/* The label toggles too: a small switch is hard to hit on a phone. */}
      <P onPress={() => onChange(!value)}>{label}</P>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.brand, false: t.border }} accessibilityLabel={label} />
    </Row>
  );
}

export function Chip({ text, tone = '' }: { text: string; tone?: 'bad' | 'warn' | 'info' | 'ok' | '' }) {
  const t = useTheme();
  const map = { bad: [t.badBg, t.bad], warn: [t.warnBg, t.warn], info: [t.infoBg, t.info], ok: [t.okBg, t.ok], '': [t.surface2, t.muted] } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

export function Chips({ items }: { items: { text: string; tone: 'bad' | 'warn' | 'info' | 'ok' | '' }[] }) {
  if (!items.length) return null;
  return (
    <Row wrap gap={6}>
      {items.map((c, i) => (
        <Chip key={i} text={c.text} tone={c.tone} />
      ))}
    </Row>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.surface2, borderRadius: radius.md, padding: 3, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="tab"
          accessibilityState={{ selected: o.value === value }}
          style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.sm, backgroundColor: o.value === value ? t.surface : 'transparent' }}
        >
          <Text style={{ color: o.value === value ? t.text : t.muted, fontWeight: '600', fontSize: 14 }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Avatar({ name, color, size = 40 }: { name: string; color?: string | null; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? t.brand, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.42 }}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' | 'warn' }) {
  const t = useTheme();
  return (
    <Card style={{ flexGrow: 1, flexBasis: 140, gap: 2 }}>
      <P small muted>{label}</P>
      <Text style={{ fontSize: 24, fontWeight: '700', color: tone ? t[tone] : t.text }}>{value}</Text>
    </Card>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <Card style={{ alignItems: 'center', paddingVertical: space.xl }}>
      <P muted>{text}</P>
    </Card>
  );
}

export function Line({ left, right, bold, muted }: { left: ReactNode; right?: ReactNode; bold?: boolean; muted?: boolean }) {
  return (
    <Row between style={{ paddingVertical: 4 }}>
      <View style={{ flex: 1 }}>
        <P bold={bold} muted={muted}>{left}</P>
      </View>
      {typeof right === 'string' ? <P bold={bold} muted={muted}>{right}</P> : right}
    </Row>
  );
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} />;
}

export function Notice({ text, tone = 'info' }: { text: string; tone?: 'bad' | 'warn' | 'info' | 'ok' }) {
  const t = useTheme();
  const map = { bad: [t.badBg, t.bad], warn: [t.warnBg, t.warn], info: [t.infoBg, t.info], ok: [t.okBg, t.ok] } as const;
  return (
    <View style={{ backgroundColor: map[tone][0], borderRadius: radius.md, padding: space.md }}>
      <Text style={{ color: map[tone][1], fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

/** A bottom sheet on phones, a centred dialog on wide screens. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' }}>
        <Pressable
          onPress={() => undefined}
          style={{ backgroundColor: t.bg, width: '100%', maxWidth: 640, maxHeight: '92%', borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingBottom: insets.bottom }}
        >
          <Row between style={{ padding: space.lg, paddingBottom: 0 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: t.text, flex: 1 }}>{title}</Text>
            <Button title="Close" variant="ghost" small onPress={onClose} />
          </Row>
          <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function Loading() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg, padding: 40 }}>
      <ActivityIndicator color={t.brand} />
    </View>
  );
}

/** Small option picker: tappable pills. */
export function Pick<T extends string>({ label, value, options, onChange }: { label?: string; value: T | null; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{label}</Text> : null}
      <Row wrap gap={6}>
        {options.map((o) => (
          <Pressable
            key={o.value}
            disabled={o.disabled}
            onPress={() => onChange(o.value)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: value === o.value ? t.brand : t.border,
              backgroundColor: value === o.value ? t.brand : t.surface,
              opacity: o.disabled ? 0.4 : 1,
            }}
          >
            <Text style={{ color: value === o.value ? t.brandText : t.text, fontWeight: '600' }}>{o.label}</Text>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}

/** Ticks once a second so running timers stay live. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
