// The part of `ws` the tests use; the repository has no @types/ws.
declare module "ws" {
  interface Socket {
    on(event: "message", listener: (data: unknown) => void): void
    send(data: string): void
    close(code?: number, reason?: string): void
    terminate(): void
  }
  export class WebSocketServer {
    constructor(options: { port: number; handleProtocols?: (protocols: Set<string>) => string | false })
    readonly clients: Set<Socket>
    on(event: "connection", listener: (socket: Socket) => void): this
    once(event: "listening" | "error", listener: () => void): this
    close(callback?: () => void): void
  }
  const WebSocket: unknown
  export default WebSocket
}
