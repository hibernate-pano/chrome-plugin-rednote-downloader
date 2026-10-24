import { MSG } from '../shared/messages';
import type { Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

let cache: Settings | null = null;
let inflight: Promise<Settings> | null = null;

export async function loadSettings(force = false): Promise<Settings> {
  if (cache && !force) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
      const settings = (res?.settings as Settings | undefined) ?? { ...DEFAULT_SETTINGS };
      cache = { ...DEFAULT_SETTINGS, ...settings };
      return cache;
    } catch {
      cache = { ...DEFAULT_SETTINGS };
      return cache;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const res = await chrome.runtime.sendMessage({ type: MSG.SAVE_SETTINGS, settings: patch });
  cache = (res?.settings as Settings | undefined) ?? { ...DEFAULT_SETTINGS, ...patch };
  return cache;
}
