export function isTargetDocumentNavigation({ method, pathname, rsc, dest, accept }) {
  return method === 'GET' && pathname === '/b' && rsc !== '1' &&
    (dest === 'document' || String(accept ?? '').includes('text/html'));
}
