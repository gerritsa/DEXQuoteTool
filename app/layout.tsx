import type { Metadata, Viewport } from "next";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./globals.css";
import "./theme.css";

const title = "SwapRank — Cross-chain quote intelligence";
const description = "Compare synchronized cross-chain quotes across 50 fixed routes and seven exact USD trade sizes.";

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0f14" },
    { media: "(prefers-color-scheme: light)", color: "#f5f8fc" },
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
  return <html lang="en" data-theme="dark" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body>{children}</body></html>;
}
