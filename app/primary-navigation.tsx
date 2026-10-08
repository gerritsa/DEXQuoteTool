import Link from "next/link";

export default function PrimaryNavigation({ active, leaderboardHref = "/", analysisHref = "/routes", volumeHref = "/volume-insights" }: {
  active: "leaderboard" | "analysis" | "volume";
  leaderboardHref?: string;
  analysisHref?: string;
  volumeHref?: string;
}) {
  return <nav aria-label="Primary navigation">
    <Link href={leaderboardHref} className={active === "leaderboard" ? "active" : undefined} aria-current={active === "leaderboard" ? "page" : undefined}>LEADERBOARD</Link>
    <Link href={analysisHref} className={active === "analysis" ? "active" : undefined} aria-current={active === "analysis" ? "page" : undefined}>ROUTE ANALYSIS</Link>
    <Link href={volumeHref} className={active === "volume" ? "active" : undefined} aria-current={active === "volume" ? "page" : undefined}>VOLUME INSIGHTS</Link>
  </nav>;
}
