import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useTheme } from '@dawgs/ui';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ fontSize: 18, color }}>{glyph}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.muted,
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('⌂') }} />
      <Tabs.Screen name="book" options={{ title: 'Book', tabBarIcon: icon('▤') }} />
      <Tabs.Screen name="walks" options={{ title: 'Walks', tabBarIcon: icon('➜') }} />
      <Tabs.Screen name="shop" options={{ title: 'Packs & classes', tabBarIcon: icon('★') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('●') }} />
    </Tabs>
  );
}
