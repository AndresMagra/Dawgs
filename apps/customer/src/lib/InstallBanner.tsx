import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Button, Card, P, Row } from '@dawgs/ui';

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const KEY = 'dawgs-install-dismissed';

function dismissedRecently() {
  try {
    const t = Number(localStorage.getItem(KEY) ?? 0);
    return Date.now() - t < 30 * 86_400_000;
  } catch {
    return false;
  }
}

/**
 * On the website only: offer to put Dawgs on the home screen. Android and
 * desktop Chrome/Edge get a one-tap install; iPhone and iPad Safari get the
 * two steps (Share, then Add to Home Screen), since Safari has no prompt.
 * Hidden once installed, and for a month after "Not now".
 */
export function InstallBanner() {
  const [prompt, setPrompt] = useState<PromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    if (standalone || dismissedRecently()) return;
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
    if (isIos && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) {
      setIos(true);
      setHidden(false);
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as PromptEvent);
      setHidden(false);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (hidden || (!prompt && !ios)) return null;
  const notNow = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      // Private browsing: just hide it for now.
    }
    setHidden(true);
  };
  return (
    <Card>
      <P bold>Put Dawgs on your home screen</P>
      <P small muted>
        {ios ? 'Tap the Share button (the square with an arrow), then "Add to Home Screen". It opens like an app, full screen.' : 'Open it like an app, full screen, in one tap.'}
      </P>
      <Row>
        {prompt ? (
          <Button
            small
            variant="primary"
            title="Add to home screen"
            onPress={async () => {
              await prompt.prompt();
              await prompt.userChoice.catch(() => undefined);
              setPrompt(null);
              setHidden(true);
            }}
          />
        ) : null}
        <Button small variant="ghost" title="Not now" onPress={notNow} />
      </Row>
    </Card>
  );
}
