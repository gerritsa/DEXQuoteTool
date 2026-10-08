// Full page navigation avoids vinext’s production RSC link handler.
export default function PrimaryNavigation({ active, leaderboardHref = "/", analysisHref = "/routes", volumeHref = "/volume-insights" }: {
  active: "leaderboard" | "analysis" | "volume";
  leaderboardHref?: string;
  analysisHref?: string;
  volumeHref?: string;
}) {
  return <nav aria-label="Primary navigation">
    <a href={leaderboardHref} className={active === "leaderboard" ? "active" : undefined} aria-current={active === "leaderboard" ? "page" : undefined}>LEADERBOARD</a>
    <a href={analysisHref} className={active === "analysis" ? "active" : undefined} aria-current={active === "analysis" ? "page" : undefined}>ROUTE ANALYSIS</a>
    <a href={volumeHref} className={active === "volume" ? "active" : undefined} aria-current={active === "volume" ? "page" : undefined}>VOLUME INSIGHTS</a>
  </nav>;
}
