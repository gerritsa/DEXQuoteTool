type Asset = { id: string; symbol: string; chain: string };
type Route = { id: string; source: Asset; destination: Asset };

function uniqueAssets<T extends Asset>(assets: T[]): T[] {
  return Array.from(new Map(assets.map((asset) => [asset.id, asset])).values())
    .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.chain.localeCompare(right.chain));
}

export function routeSourceAssets<T extends Asset>(routes: Array<{ source: T }>): T[] {
  return uniqueAssets(routes.map((route) => route.source));
}

export function routeDestinationAssets<T extends Asset>(routes: Array<{ source: Asset; destination: T }>, sourceId: string): T[] {
  return uniqueAssets(routes.filter((route) => route.source.id === sourceId).map((route) => route.destination));
}

export function findSelectedRoute<T extends Route>(routes: T[], sourceId: string, destinationId: string): T | null {
  return routes.find((route) => route.source.id === sourceId && route.destination.id === destinationId) ?? null;
}

export function reverseRoute<T extends Route>(routes: T[], route: T): T | null {
  return findSelectedRoute(routes, route.destination.id, route.source.id);
}
