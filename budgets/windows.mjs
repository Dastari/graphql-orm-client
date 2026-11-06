import { createServer } from "node:http"
import { build } from "esbuild"
import { WebSocketServer } from "ws"
import { chromium } from "playwright"
import { once } from "node:events"

export async function measureWindows(compiled) {
  if (process.argv.includes("--skip-window")) {
    console.error("window budget not run: explicitly skipped; result is incomplete")
    return null
  }
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    console.error("window budget not run: " + error.message)
    throw new Error("window budget not run (install Chromium, or explicitly pass --skip-window)")
  }
  let server, wss
  try {
    const bundle = await build({ entryPoints: ["budgets/window.mjs"], bundle: true, write: false,
      platform: "browser", format: "esm", minify: true })
    server = createServer((req, res) => {
      res.setHeader("Content-Type", req.url === "/app.js" ? "text/javascript" : req.url === "/artifacts" ? "application/json" : "text/html")
      res.end(req.url === "/app.js" ? bundle.outputFiles[0].contents :
        req.url === "/artifacts" ? JSON.stringify(compiled) : '<!doctype html><title>Window budget</title><script type="module" src="/app.js"></script>')
    })
    // Stay inside the task's assigned loopback port range; retry occupied ports.
    for (let port = 43000; port <= 43099; port++) {
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve() })
        })
        break
      } catch (error) { if (error.code !== "EADDRINUSE" || port === 43099) throw error }
    }
    wss = new WebSocketServer({ server, path: "/graphql" })
    const subscribedSockets = new WeakSet()
    wss.on("connection", socket => socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString())
      if (message.type === "connection_init") socket.send(JSON.stringify({ type: "connection_ack" }))
      if (message.type === "subscribe") subscribedSockets.add(socket)
    }))
    const browserVersion = browser.version()
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const pages = [page]
    const measurements = []
    for (const count of [1, 3, 6]) {
      while (pages.length < count) {
        const popup = context.waitForEvent("page")
        await page.evaluate(() => window.openTool())
        pages.push(await popup)
      }
      for (const entry of pages) await entry.waitForFunction(() => window.budget?.rows === 10000)
      const deadline = Date.now() + 30000
      while ((wss.clients.size !== count || ![...wss.clients].every(socket => subscribedSockets.has(socket))) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20))
      if (wss.clients.size !== count || ![...wss.clients].every(socket => subscribedSockets.has(socket))) throw new Error("window sockets/subscriptions did not become ready")
      let heapBytes = 0
      const isolates = new Set()
      for (const entry of pages) {
        const session = await context.newCDPSession(entry)
        await session.send("HeapProfiler.collectGarbage")
        const { id } = await session.send("Runtime.getIsolateId")
        if (!isolates.has(id)) {
          heapBytes += (await session.send("Runtime.getHeapUsage")).usedSize
          isolates.add(id)
        }
        await session.detach()
      }
      measurements.push({ windows: count, heapBytes, sockets: wss.clients.size,
        rowsPerWindow: 10000, isolates: isolates.size, browserVersion })
    }
    await context.close()
    return measurements
  } finally {
    await browser.close()
    if (wss) {
      for (const socket of wss.clients) socket.terminate()
      await new Promise(resolve => wss.close(resolve))
    }
    if (server?.listening) { server.close(); await once(server, "close") }
  }
}
