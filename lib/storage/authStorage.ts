/**
 * Supabase Auth storage adapter.
 *
 * Today: wraps window.localStorage.
 * Later (PR after Capacitor scaffold): detect native runtime and route to
 * @capacitor/preferences (Keychain on iOS, EncryptedSharedPreferences on Android).
 *
 * Consumers must not import localStorage directly — always go through this.
 */

// Matches the shape Supabase Auth expects (SupportedStorage).
export interface AuthStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

const isBrowser = typeof window !== 'undefined';

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

export function getAuthStorage(): AuthStorage {
  // Later: if (isNative()) return capacitorPreferencesAdapter;
  return localStorageAdapter;
}
