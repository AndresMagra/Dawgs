import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Field, ForgotPassword, H1, Notice, P, ResetPassword, useResetToken, useTheme } from '@dawgs/ui';
import { api, useSession } from './session';

export default function Login() {
  const t = useTheme();
  const { signIn, acceptToken } = useSession();
  const [forgot, setForgot] = useState(false);
  const [resetToken, clearReset] = useResetToken();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg, justifyContent: 'center', padding: 24 }}>
      <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 16 }}>
        <H1>Dawgs Staff</H1>
        <P muted>Sign in with the email your manager set up for you.</P>
        {resetToken ? (
          <ResetPassword
            reset={async (pw) => {
              const r = await api.post<{ token: string }>('/auth/reset', { token: resetToken, password: pw });
              clearReset();
              await acceptToken(r.token);
              router.replace('/');
            }}
            onCancel={() => {
              clearReset();
              router.replace('/');
            }}
          />
        ) : forgot ? (
          <ForgotPassword initialEmail={email} send={(e) => api.post('/auth/forgot', { email: e, app: 'staff' })} onBack={() => setForgot(false)} />
        ) : (
          <Card>
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={() => void submit()} />
            {error ? <Notice tone="bad" text={error} /> : null}
            <Button title="Sign in" variant="primary" onPress={submit} />
            <Button title="Forgot password?" variant="ghost" onPress={() => setForgot(true)} />
          </Card>
        )}
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
