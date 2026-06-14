const WS_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "https://keeps-larger-doubt-diploma.trycloudflare.com").replace(
  /^https?/,
  (p) => (p === "https" ? "wss" : "ws")
);

export function connectSimWs(
  simId: string,
  channels: string,
  onMessage: (data: unknown) => void,
  token?: string | null
): WebSocket {
  let url = `${WS_BASE}/ws/simulations/${simId}?channels=${channels}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data as string));
    } catch {}
  };
  return ws;
}

export function connectGlobalWs(onMessage: (data: unknown) => void): WebSocket {
  const ws = new WebSocket(`${WS_BASE}/ws/global`);
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data as string));
    } catch {}
  };
  return ws;
}
