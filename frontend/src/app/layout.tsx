import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RAG App",
  description: "Ask questions about your documents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
