import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const title = "SwapRank — Cross-chain quote intelligence";
const description = "Compare synchronized cross-chain quotes across 30 fixed routes and seven exact USD trade sizes.";

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d0f0e" },
    { media: "(prefers-color-scheme: light)", color: "#f2f4ec" },
  ],
};

export const metadata: Metadata = {
  title,
  description,
  applicationName: "SwapRank",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }, { url: "/favicon-32.png", sizes: "32x32", type: "image/png" }],
    shortcut: "/favicon.svg",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary", title, description },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const themeScript = "try{document.documentElement.dataset.theme=localStorage.getItem('swaprank-theme')==='light'?'light':'dark'}catch(e){document.documentElement.dataset.theme='dark'}";
  return <html lang="en" data-theme="dark" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
