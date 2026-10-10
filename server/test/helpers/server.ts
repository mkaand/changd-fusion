import type { Server } from "node:http";
export async function closeServer(server: Server): Promise<void> {
  // close() alone waits for browser/proxy keep-alives. Fixtures never need to drain requests.
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error &&
      (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        ? reject(error)
        : resolve(),
    ),
  );
  server.closeAllConnections();
  await closed;
}
