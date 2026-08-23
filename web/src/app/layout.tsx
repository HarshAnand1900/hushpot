import type { Metadata } from "next";
// Google consolidated "Big Shoulders Display" into the "Big Shoulders" variable family.
import { Big_Shoulders, IBM_Plex_Mono, Newsreader, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

import { NetworkGuard } from "@/components/NetworkGuard";

import { Toast } from "@/components/Toast";
import { Providers } from "./providers";
import "./globals.css";

// Self-hosted by next/font, so there is no CDN request and no flash of fallback type.
const shoulders = Big_Shoulders({
  subsets: ["latin"],
  weight: ["700"],
  variable: "--font-shoulders",
  display: "swap",
});

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-grotesk",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["500"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hushpot — confidential prize pool",
  description:
    "A no-loss prize pool where deposits, balances and odds stay encrypted, and the winner is never resolved on-chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${shoulders.variable} ${grotesk.variable} ${mono.variable} ${newsreader.variable}`}>
        {/* Fixed atmosphere behind everything. Never interactive. */}
        <div className="backdrop" aria-hidden="true">
          <div className="blobA" />
          <div className="blobB" />
          <div className="lattice" />
          <div className="scan" />
        </div>
        <div className="scanlines" aria-hidden="true" />

        {/* Above everything, on every page: wallet flows are long enough that people look
            away, and the app used to return to its resting state without ever saying
            whether the thing they started had worked. */}
        <Toast />

        <div className="content">
          <Providers>
            {/* Sits above everything: connecting on the wrong chain otherwise just
                looks like the app is broken, with nothing to explain why. */}
            <NetworkGuard />
            {children}
          </Providers>
        </div>
      </body>
    </html>
  );
}
