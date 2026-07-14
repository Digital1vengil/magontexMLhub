// Proxy same-origin de /api/* -> Worker parkahub-api.
//
// El browser llega aca YA autenticado por Cloudflare Access: la app de Access cubre
// parkahub.pages.dev (+ *.parkahub.pages.dev), valida en el edge ANTES de que corra esta
// Function, y estampa el header Cf-Access-Jwt-Assertion en el request. Lo reenviamos al
// Worker, que valida ese JWT (firma RS256 + aud + iss). El browser NO manda ninguna
// credencial: la API key salio del bundle por completo.
//
// Un hit directo al Worker publico (parkahub-api.workers.dev) NO pasa por Access, no trae
// JWT valido -> el Worker responde 403. Asi se cierra el flanco del Worker.

const BACKEND = 'https://parkahub-api.magontex.workers.dev'

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  const { request } = context
  const inUrl = new URL(request.url)
  const target = BACKEND + inUrl.pathname + inUrl.search

  const headers = new Headers(request.headers)
  headers.delete('host') // que fetch use el host del Worker, no el de Pages

  // Los headers cf-* pueden stripearse en un fetch worker->worker; reenviamos el JWT
  // bajo un nombre propio que sobrevive, y el Worker lo lee de cualquiera de los dos.
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion')
  if (jwt) headers.set('X-Access-Jwt', jwt)

  // Bufferizamos el body (los payloads de /api/state son chicos) para evitar problemas
  // de stream/duplex en el reenvio.
  let body: BodyInit | undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') body = await request.arrayBuffer()

  return fetch(target, { method: request.method, headers, body, redirect: 'manual' })
}
