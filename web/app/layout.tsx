import type { Metadata, Viewport } from 'next';
import { Fraunces, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Fraunces carries the display voice — its wonk axis gives the headings a
 * printed-page character that a neutral grotesque would not. IBM Plex Sans sets
 * the body; it ships a Devanagari companion, which matters for a platform whose
 * creators will not all be writing in Latin script. Plex Mono holds every
 * figure, so money lines up in columns the way a ledger requires.
 */
const display = Fraunces({
  subsets: ['latin'],
  axes: ['SOFT', 'WONK', 'opsz'],
  display: 'swap',
  variable: '--font-display',
});

const body = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-body',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'CraftGuild — Publishing that pays straight through',
  description:
    'An India-first publishing platform for serialised fiction and comics. Our fee is 10%. Every other rupee is accounted for, and your share is paid by an RBI-authorised aggregator directly into your own bank account.',
  openGraph: {
    title: 'CraftGuild — Publishing that pays straight through',
    description:
      'Our fee is 10%. Every other rupee is accounted for, and your earnings never pass through our hands.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1226' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
