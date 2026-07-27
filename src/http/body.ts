type BoundedRequest =
  | { request: Request; rejection?: never }
  | { request?: never; rejection: Response };

function tooLargeResponse(maxBytes: number): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: `Request body exceeds the ${maxBytes} byte limit`,
      },
      id: null,
    },
    { status: 413 },
  );
}

/** Buffer one bounded MCP JSON message and reconstruct an unread Request for the SDK. */
export async function boundedMcpRequest(
  request: Request,
  maxBytes: number,
): Promise<BoundedRequest> {
  if (request.method !== 'POST' || !request.body) return { request };

  const contentLength = request.headers.get('Content-Length');
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { rejection: tooLargeResponse(maxBytes) };
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('MCP request body too large');
      return { rejection: tooLargeResponse(maxBytes) };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { request: new Request(request, { body }) };
}
