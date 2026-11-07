import { paraphraseKeepsFacts } from '@gst/ai';

/** A thin re-export so the web test exercises the package through the app's alias. */
export const paraphraseGuard = (a: string, b: string) => paraphraseKeepsFacts(a, b);
