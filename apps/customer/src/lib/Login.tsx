import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, Field, ForgotPassword, H1, Notice, P, ResetPassword, Segmented, useResetToken, useTheme } from '@dawgs/ui';
import { api, useSession } from './session';

/**
 * Sign in, or create an account with the daycare's code (the daycare hands it
 * out, or it arrives in the link). If the front desk already has the owner's
 * email on file, the new login joins that record and its dogs.
 */
export default function Login() {
  const t = useTheme();
  const { signIn, signUp, acceptToken } = useSession();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [forgot, setForgot] = useState(false);
  const [resetToken, clearReset] = useResetToken();
  const [f, setF] = useState({ business: '', name: '', email: '', phone: '', password: '' });
  const [daycare, setDaycare] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const code = new URLSearchParams(window.location.search).get('daycare');
    if (code) {
      setF((x) => ({ ...x, business: code }));
      setMode('up');
    }
  }, []);
  useEffect(() => {
    const code = f.business.trim().toLowerCase();
    if (code.length < 3) return setDaycare(null);
    const h = setTimeout(() => {
      api
        .get<{ name: string }>(`/public/daycares/${encodeURIComponent(code)}`)
        .then((d) => setDaycare(d.name))
        .catch(() => setDaycare(null));
    }, 350);
    return () => clearTimeout(h);
  }, [f.business]);

  async function submit() {
    setError(null);
    try {
      if (mode === 'in') await signIn(f.email.trim(), f.password);
      else await signUp({ business: f.business.trim().toLowerCase(), name: f.name.trim(), email: f.email.trim(), ...(f.phone.trim() ? { phone: f.phone.trim() } : {}), password: f.password });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 16 }}>
          <H1>Dawgs</H1>
          <P muted>Book daycare and boarding, follow walks live, see report cards and pay, all in one place.</P>
          {resetToken ? (
            <ResetPassword
              reset={async (password) => {
                const r = await api.post<{ token: string }>('/auth/reset', { token: resetToken, password });
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
            <ForgotPassword initialEmail={f.email} send={(email) => api.post('/auth/forgot', { email, app: 'customer' })} onBack={() => setForgot(false)} />
          ) : (
          <>
          <Segmented value={mode} onChange={setMode} options={[{ value: 'in', label: 'Sign in' }, { value: 'up', label: 'Create account' }]} />
          <Card>
            {mode === 'up' ? (
              <>
                <Field label="Daycare code" value={f.business} onChangeText={set('business')} autoCapitalize="none" placeholder="Ask your daycare" />
                {daycare ? <Notice tone="ok" text={daycare} /> : null}
                <Field label="Your name" value={f.name} onChangeText={set('name')} autoComplete="name" />
                <Field label="Mobile (for pickup texts)" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
              </>
            ) : null}
            <Field label="Email" value={f.email} onChangeText={set('email')} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
            <Field
              label={mode === 'up' ? 'Choose a password (8+ characters)' : 'Password'}
              value={f.password}
              onChangeText={set('password')}
              secureTextEntry
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              textContentType={mode === 'up' ? 'newPassword' : 'password'}
              onSubmitEditing={() => void submit()}
            />
            {error ? <Notice tone="bad" text={error} /> : null}
            <Button title={mode === 'in' ? 'Sign in' : 'Create account'} variant="primary" disabled={mode === 'up' && !daycare} onPress={submit} />
            {mode === 'in' ? <Button title="Forgot password?" variant="ghost" onPress={() => setForgot(true)} /> : null}
          </Card>
          </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
