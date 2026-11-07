import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Khmer Subtitle Translator",
  description: "Translate subtitles and create Khmer voice dubs locally.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
