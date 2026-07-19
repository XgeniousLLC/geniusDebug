import type { ReactNode } from 'react';

export const metadata = {
  title: 'geniusDebug — local test app',
  description: 'Throws errors and records replays into a locally running geniusDebug.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
