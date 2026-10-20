import type { Metadata } from "next";
import "./globals.css";
import "./video-studio.css";
import "./video-agent.css";

export const metadata: Metadata = { title: "AI Video Agent · Prompt Studio", description: "Plan scenes with Codex CLI and generate H3 videos with RunPod in your local workspace." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
