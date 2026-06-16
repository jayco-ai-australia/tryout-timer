import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tryout Timer",
  description: "Chassis tryout session timer and tracking",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
