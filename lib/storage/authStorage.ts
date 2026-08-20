/**
 * Supabase Auth storage adapter.
 *
 * Runtime detection:
 * - Native Capacitor shell → @capacitor/preferences (Keychain on iOS,
 *   EncryptedSharedPreferences on Android).
 * - Browser (Vercel web build) → window.localStorage.
 * - SSR / build-time → no-op returning null.
 *
 * Consumers must not import localStorage or Preferences directly — always
 * go through getAuthStorage().
 */

import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

// Matches the shape Supabase Auth expects (SupportedStorage).
export interface AuthStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

const isBrowser = typeof window !== 'undefined';
const isNative = () => isBrowser && Capacitor.isNativePlatform();

/**
 * SSR-safe localStorage wrapper. Returns null / no-ops during SSR so that
 * Supabase client construction on the server side does not throw.
 */
const localStorageAdapter: AuthStorage = {
  getItem(key) {
    if (!isBrowser) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    if (!isBrowser) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota exceeded, private mode, etc. — silently drop.
    }
  },
  removeItem(key) {
    if (!isBrowser) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // no-op
    }
  },
};

const capacitorPreferencesAdapter: AuthStorage = {
  async getItem(key) {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  },
  async setItem(key, value) {
    await Preferences.set({ key, value });
  },
  async removeItem(key) {
    await Preferences.remove({ key });
  },
};

export function getAuthStorage(): AuthStorage {
  return isNative() ? capacitorPreferencesAdapter : localStorageAdapter;
}
