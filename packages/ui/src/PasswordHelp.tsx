import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Button, Card, Field, H2, Notice, P } from './components';

/** "Forgot password?": asks for the email and always answers the same way, so it never reveals who has an account. */
export function ForgotPassword({ send, onBack, initialEmail = '' }: { send: (email: string) => Promise<unknown>; onBack: () => void; initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter the email you sign in with.');
    try {
      await send(email.trim());
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Card>
      <H2>Reset your password</H2>
      {sent ? (
        <Notice tone="ok" text={`If ${email.trim()} has an account, a link to choose a new password is on its way. It works for an hour. Check your spam folder if you don't see it.`} />
      ) : (
        <>
          <P muted>We'll email you a link to choose a new one.</P>
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" onSubmitEditing={() => void submit()} />
          {error ? <Notice tone="bad" text={error} /> : null}
          <Button title="Email me a link" variant="primary" onPress={submit} />
        </>
      )}
      <Button title="Back to sign in" variant="ghost" onPress={onBack} />
    </Card>
  );
}

/** The page a reset link opens: pick a new password, then you're signed in. */
export function ResetPassword({ reset, onCancel, minLength = 8 }: { reset: (password: string) => Promise<unknown>; onCancel: () => void; minLength?: number }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    if (password.length < minLength) return setError(`Use at least ${minLength} characters.`);
    if (password !== again) return setError("The two passwords don't match.");
    try {
      await reset(password);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Card>
      <H2>Choose a new password</H2>
      <Field label={`New password (${minLength}+ characters)`} value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Field label="Type it again" value={again} onChangeText={setAgain} secureTextEntry autoComplete="new-password" textContentType="newPassword" onSubmitEditing={() => void submit()} />
      {error ? <Notice tone="bad" text={error} /> : null}
      <Button title="Save and sign in" variant="primary" onPress={submit} />
      <Button title="Cancel" variant="ghost" onPress={onCancel} />
    </Card>
  );
}

/** On the web, the token from a reset link (`…/reset?token=…`), or null. */
export function useResetToken(): [string | null, () => void] {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (!/\/reset\/?$/.test(window.location.pathname)) return;
    setToken(new URLSearchParams(window.location.search).get('token'));
  }, []);
  const clear = () => {
    setToken(null);
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname.replace(/\/reset\/?$/, '/') || '/');
  };
  return [token, clear];
}
