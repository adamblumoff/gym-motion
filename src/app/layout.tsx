import type { Metadata } from "next";
import { IBM_Plex_Mono, Sora, Urbanist } from "next/font/google";

import "./globals.css";

const displayFont = Urbanist({
  subsets: ["latin"],
  variable: "--font-display",
});

const bodyFont = Sora({
  subsets: ["latin"],
  variable: "--font-body",
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Gym Motion",
  description: "Minimal motion sensor dashboard for ESP32 devices.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
