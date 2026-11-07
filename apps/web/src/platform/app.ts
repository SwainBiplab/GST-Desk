/**
 * The phone app's lifecycle (prompt 43): the hardware back button goes back in the app and leaves it
 * from the Home tab; coming to the foreground is when the app lock asks again and a sync is tried.
 */
import { hasPlugin } from './index';

type Off = () => Promise<void>;

/** `fn` answers true when it handled the press; false lets the app go to the background. */
export async function onBackButton(fn: () => boolean): Promise<Off> {
  if (!hasPlugin('App')) return async () => undefined;
  const { App } = await import('@capacitor/app');
  const h = await App.addListener('backButton', () => {
    const handled = fn();
    if (handled === false) void App.minimizeApp();
  });
  return () => h.remove();
}

export async function onForeground(fn: (active: boolean) => void): Promise<Off> {
  if (!hasPlugin('App')) {
    const h = () => fn(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', h);
    return async () => document.removeEventListener('visibilitychange', h);
  }
  const { App } = await import('@capacitor/app');
  const h = await App.addListener('appStateChange', (s) => fn(s.isActive));
  return () => h.remove();
}

/** Status bar and splash: the WebView draws under the status bar, so the layout pads for it. */
export async function readyForDisplay(): Promise<void> {
  if (hasPlugin('SplashScreen')) {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide().catch(() => undefined);
  }
  if (hasPlugin('Keyboard')) {
    const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
    await Keyboard.setResizeMode({ mode: KeyboardResize.Body }).catch(() => undefined);
  }
}

export async function tap(): Promise<void> {
  if (!hasPlugin('Haptics')) return;
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
}
