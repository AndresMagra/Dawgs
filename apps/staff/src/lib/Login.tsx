import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Button, Card, Field, H1, Notice, P, useTheme } from '@dawgs/ui';
import { useSession } from './session';

export default function Login() {
  const t = useTheme();
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg, justifyContent: 'center', padding: 24 }}>
      <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 16 }}>
        <H1>Dawgs Staff</H1>
        <P muted>Sign in with the email your manager set up for you.</P>
        <Card>
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={() => void submit()} />
          {error ? <Notice tone="bad" text={error} /> : null}
          <Button title="Sign in" variant="primary" onPress={submit} />
        </Card>
      </View>
    </KeyboardAvoidingView>
  );
  async function submit() {
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError((e as Error).message);
    }
  }
}
