import * as React from 'react';
import { NavLink } from 'react-router-dom';

/** Shared shell for the account pages (Edit profile / Change password). */
export function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-5">
      <h1 className="mb-4 text-h1 font-semibold">Account</h1>
      <div className="mb-5 flex gap-1 border-b border-border">
        {[
          { to: '/account/profile', label: 'Edit profile' },
          { to: '/account/password', label: 'Change password' },
        ].map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-small ${
                isActive ? 'border-accent text-text' : 'border-transparent text-text-muted hover:text-text'
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      {children}
    </div>
  );
}
