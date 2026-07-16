import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthUserDto } from '@geniusdebug/shared';
import { setToken } from '../lib/api';

interface UiState {
  user: AuthUserDto | null;
  theme: 'dark' | 'light';
  environment: string; // global env filter (brief §3)
  setAuth: (token: string, user: AuthUserDto) => void;
  signOut: () => void;
  toggleTheme: () => void;
  setEnvironment: (e: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      user: null,
      theme: 'dark',
      environment: 'all',
      setAuth: (token, user) => {
        setToken(token);
        set({ user });
      },
      signOut: () => {
        setToken(null);
        set({ user: null });
      },
      toggleTheme: () => {
        const next = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        set({ theme: next });
      },
      setEnvironment: (environment) => set({ environment }),
    }),
    {
      name: 'gd_ui',
      partialize: (s) => ({ user: s.user, theme: s.theme, environment: s.environment }),
      // Reapply the theme once persisted state rehydrates (survives hard reloads).
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

export function applyTheme(theme: 'dark' | 'light') {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}
