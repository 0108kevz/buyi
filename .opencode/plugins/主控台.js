// I4582 W7 駕駛艙中控台：老闆在網頁上跟 AI 代表談、按鍵，這支外掛轉給 OpenCode，並把公司的狀態、成品送回網頁。
//
// 為什麼是外掛：學生用 OpenCode 電腦版，不必開終端機。開這個專案、按「新增工作階段」，
// OpenCode 就自動載入 .opencode/plugins/ 裡的外掛，這支就在 http://127.0.0.1:4777 開好中控台。
// 2026-10-11 實測：電腦版跑外掛的環境沒有 Bun（Bun.serve 會 ReferenceError），所以只用 node: 內建模組。
// 2026-11-07 W7 加：跟 AI 代表的對話區（同一段對話一直接著談）、請它先停下來、AI 團隊與待辦、成品櫃。
// 做法借自 W5 逆分工實戰手冊的雙向主控台，那一版要另外用命令列開 opencode serve；這一版全部走外掛拿到的 client。
//
// 安全：只聽 127.0.0.1；只接受固定幾種動作，不接受任意指令；每次開專案產生一把隨機鑰匙，
// 只放在外掛自己送出去的中控台網頁裡。別的網站讀不到這一頁（沒有開跨站讀取），就拿不到鑰匙，送不了動作。
// 成品櫃只送 成品/ 底下的檔，路徑裡有 .. 一律拒絕。
// 2026-11-08 加「八、我的公司加的」：中控台是基本款，學生跟 AI 團隊在 公司/中控台加的.json 寫上自己公司要看的區、要按的鍵，
// 不用改這支外掛就接得上。按鍵只跑那份檔裡寫好的指令（照名稱對），網頁送不了任意指令；/看/ 送資料夾裡的檔，. 開頭與 .. 一律拒絕。
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, stat } from "node:fs/promises"
import { join, normalize, extname, sep } from "node:path"
import { randomBytes } from "node:crypto"

const 起始埠 = 4777

const 前言 = {
  討論: 話 => "【中控台・老闆按「跟它討論」：這一則只想、只回話，不動任何檔，不跑任何指令】\n" + 話,
  照做: 話 => "【中控台・老闆按「照這樣做」：照 AGENTS.md 開工，每一步都更新 公司/公司資料.json 的目前階段與流程狀態】\n" + 話,
  回答: 話 => "【中控台・老闆在「AI 在等你的事」回答了】\n" + 話 + "\n把這個決定寫進 公司/公司資料.json 那一題的「老闆的決定」。你原本在做成品，就接著做；原本是開好公司、在等老闆看策略與流程，就停在那裡，等他按「照這樣做」。",
}

const 型別 = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
}

export const 主控台 = async ({ client, directory }) => {
  const 鑰匙 = randomBytes(16).toString("hex")
  const 記 = (level, message) => client.app.log({ body: { service: "中控台", level, message } }).catch(() => {})
  const 讀身體 = req => new Promise((ok, no) => {
    let b = ""
    req.on("data", c => { b += c; if (b.length > 20000) no(new Error("太長")) })
    req.on("end", () => ok(b))
  })
  const 回 = (res, code, type, body) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body) }
  const 回JSON = (res, 物) => 回(res, 200, "application/json; charset=utf-8", JSON.stringify(物))
  const 取 = r => r?.data ?? r

  // AI 代表固定用同一段對話，老闆在中控台講的話一直接著談。對話編號存在 公司/代表對話.txt
  const 代表檔 = join(directory, "公司", "代表對話.txt")
  let 代表 = ""
  const 找代表 = async (要建) => {
    if (!代表) { try { 代表 = (await readFile(代表檔, "utf8")).trim() } catch {} }
    if (代表) {
      try { const s = 取(await client.session.get({ path: { id: 代表 } })); if (s?.id) return 代表 } catch {}
      代表 = ""
    }
    if (!要建) return ""
    const s = 取(await client.session.create({ body: { title: "中控台：AI 代表" } }))
    代表 = s.id
    await mkdir(join(directory, "公司"), { recursive: true })
    await writeFile(代表檔, 代表 + "\n")
    return 代表
  }

  const 讀資料 = async () => {
    let 資料 = "{}"
    try {
      資料 = await readFile(join(directory, "公司", "公司資料.json"), "utf8")
      try { JSON.parse(資料) }
      catch {
        // 公司寫檔時常在字串裡留下看不見的 Tab、換行（2026-10-11 電腦版實跑撞到）。換成空白再讀；多出來的反斜線拿掉
        const 修 = 資料.replace(/[\u0000-\u001f]/g, " ").replace(/\\(?!["\\/bfnrtu])/g, "")
        JSON.parse(修); 資料 = 修
      }
    }
    catch (e) { 資料 = JSON.stringify({ 還沒有: String(e).includes("ENOENT") ? "公司還沒蓋" : "公司資料.json 讀不了：公司可能正在寫，等一分鐘；一直這樣的話，在對話區跟 AI 代表說「公司資料.json 讀不了，請修好格式」" }) }
    return 資料
  }

  // 「八、我的公司加的」那幾個鍵的最近一次結果；上次開著時的紀錄從 公司/按鍵紀錄.json 讀回來
  let 跑的紀錄 = {}
  try { 跑的紀錄 = JSON.parse(await readFile(join(directory, "公司", "按鍵紀錄.json"), "utf8")); for (const k in 跑的紀錄) 跑的紀錄[k].正在跑 = false } catch {}

  const 伺服器 = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1")
      const 路 = decodeURIComponent(u.pathname)   // 瀏覽器會把中文網址轉成 %E8… 的編碼
      if (req.method === "GET" && 路 === "/") {
        const 頁 = (await readFile(join(directory, "主控台.html"), "utf8")).replace("__鑰匙__", 鑰匙)
        return 回(res, 200, "text/html; charset=utf-8", 頁)
      }
      if (req.method === "GET" && 路 === "/資料") return 回(res, 200, "application/json; charset=utf-8", await 讀資料())

      if (req.method === "GET" && 路 === "/對話") {
        const id = await 找代表(false)
        if (!id) return 回JSON(res, { 還沒開始: true, 訊息: [], 忙: false, 待辦: [], 幫手: [] })
        const 訊息們 = 取(await client.session.messages({ path: { id } })) || []
        const 訊息 = 訊息們.slice(-40).map(m => {
          const info = m.info || m
          const 字 = (m.parts || []).filter(p => p.type === "text" && !p.synthetic).map(p => p.text).join("\n").trim()
          const 工具 = (m.parts || []).filter(p => p.type === "tool").map(p => p.tool + (p.state?.status === "running" ? "（進行中）" : ""))
          return { 誰: info.role === "user" ? "老闆" : "AI 代表", 字, 工具, 時間: info.time?.created || 0 }
        }).filter(m => m.字 || m.工具.length)
        let st = {}
        try { st = 取(await client.session.status()) || {} } catch {}
        const 忙 = !!st[id] && st[id].type !== "idle"
        // 最後一則 AI 的回覆出錯（例如免費模型額度用完回「Invalid credential」），送給中控台顯示，不然老闆只看到它一直不動
        const 末 = [...訊息們].reverse().find(m => (m.info || m).role === "assistant")
        const 錯 = 末 && (末.info || 末).error
        const 錯誤 = 錯 && !忙 ? String(錯.data?.message || 錯.name || "出錯了") : ""
        const 模型 = 末 ? [(末.info || 末).providerID, (末.info || 末).modelID].filter(Boolean).join("/") : ""
        // 最後一次動靜：最後幾則訊息與其中每一段的時間取最晚的。忙著卻很久沒動靜，就是卡住了（2026-11-07 實跑：開了一則新回覆後四小時一個字都沒有）
        let 動靜 = 0
        for (const m of 訊息們.slice(-3)) {
          const t = (m.info || m).time || {}; 動靜 = Math.max(動靜, t.created || 0, t.completed || 0)
          for (const p of m.parts || []) { const pt = p.time || p.state?.time || {}; 動靜 = Math.max(動靜, pt.start || 0, pt.end || 0) }
        }
        const 卡住 = 忙 && 動靜 > 0 && Date.now() - 動靜 > 3 * 60 * 1000
        let 待辦 = [], 幫手 = []
        try { 待辦 = (取(await client.session.todo({ path: { id } })) || []).map(t => ({ 內容: t.content, 狀態: t.status })) } catch {}
        try { 幫手 = (取(await client.session.children({ path: { id } })) || []).map(k => ({ 名字: k.title, 在做: !!st[k.id] && st[k.id].type !== "idle" })) } catch {}
        return 回JSON(res, { 訊息, 忙, 待辦, 幫手, 錯誤, 模型, 卡住, 幾分鐘沒動: 動靜 ? Math.round((Date.now() - 動靜) / 60000) : 0 })
      }

      if (req.method === "POST" && (路 === "/說" || 路 === "/停" || 路 === "/重來")) {
        if (req.headers["x-key"] !== 鑰匙) return 回(res, 403, "text/plain; charset=utf-8", "鑰匙不對")
        if (路 === "/重來") {
          // 卡住時：停掉舊的那一段，開一段新的 AI 代表對話，請它讀公司資料接著做。實跑發現同一段對話接著問常常還是卡，開新的才解得開
          const { 模型 } = JSON.parse((await 讀身體(req)) || "{}")
          const 舊 = await 找代表(false)
          if (舊) await client.session.abort({ path: { id: 舊 } }).catch(() => {})
          代表 = ""; try { await writeFile(代表檔, "") } catch {}
          const id = await 找代表(true)
          const body = { parts: [{ type: "text", text: "【中控台・老闆按「卡住了，換一段新對話接著做」】\n上一段對話卡住了，這是新的一段。先讀 AGENTS.md、公司/記住的事.md、公司/公司資料.json，看流程做到哪、成品/ 裡已經有哪些檔（有做好卻還沒登記進 成品 的，先登記），然後從還沒完成的那一步接著做。先用一兩句告訴老闆你看到做到哪、接下來做什麼。" }] }
          if (模型 && /^[\w.-]+\/[\w.:-]+$/.test(模型)) { const [providerID, ...rest] = 模型.split("/"); body.model = { providerID, modelID: rest.join("/") } }
          ;(client.session.promptAsync ? client.session.promptAsync({ path: { id }, body }) : client.session.prompt({ path: { id }, body })).catch(e => 記("error", "重來失敗：" + e))
          return 回JSON(res, { ok: true })
        }
        if (路 === "/停") {
          const id = await 找代表(false)
          if (id) {
            try { const kids = 取(await client.session.children({ path: { id } })) || []; await Promise.all(kids.map(k => client.session.abort({ path: { id: k.id } }).catch(() => {}))) } catch {}
            await client.session.abort({ path: { id } }).catch(() => {})
          }
          return 回JSON(res, { ok: true })
        }
        const { 模式, 話, 模型 } = JSON.parse(await 讀身體(req))
        if (!前言[模式]) return 回(res, 400, "text/plain; charset=utf-8", "沒有這個動作")
        if (!String(話 || "").trim()) return 回(res, 400, "text/plain; charset=utf-8", "沒有寫字")
        const id = await 找代表(true)
        const body = { parts: [{ type: "text", text: 前言[模式](String(話).slice(0, 4000)) }] }
        // 老闆在中控台選了頭腦（模型）就用那一個；沒選就用 opencode.json 的預設
        if (模型 && /^[\w.-]+\/[\w.:-]+$/.test(模型)) { const [providerID, ...rest] = 模型.split("/"); body.model = { providerID, modelID: rest.join("/") } }
        const 送 = client.session.promptAsync ? client.session.promptAsync({ path: { id }, body }) : client.session.prompt({ path: { id }, body })
        送.catch(e => 記("error", "送給 AI 代表失敗：" + e))
        return 回JSON(res, { ok: true })
      }

      if (req.method === "GET" && 路 === "/加的") {
        let 加 = {}
        try { 加 = JSON.parse(await readFile(join(directory, "公司", "中控台加的.json"), "utf8")) }
        catch (e) { 加 = String(e).includes("ENOENT") ? {} : { 讀不了: "公司/中控台加的.json 格式壞了：" + String(e.message || e).slice(0, 200) } }
        return 回JSON(res, { ...加, 跑的紀錄: 跑的紀錄 })
      }

      if (req.method === "POST" && 路 === "/按") {
        if (req.headers["x-key"] !== 鑰匙) return 回(res, 403, "text/plain; charset=utf-8", "鑰匙不對")
        const { 名稱 } = JSON.parse((await 讀身體(req)) || "{}")
        let 加 = {}
        try { 加 = JSON.parse(await readFile(join(directory, "公司", "中控台加的.json"), "utf8")) } catch (e) { return 回(res, 400, "text/plain; charset=utf-8", "公司/中控台加的.json 讀不了：" + e.message) }
        const 鍵 = (加.按鍵 || []).find(k => k.名稱 === 名稱)
        if (!鍵 || !String(鍵.指令 || "").trim()) return 回(res, 400, "text/plain; charset=utf-8", "公司/中控台加的.json 裡沒有這個鍵，或它沒寫指令")
        if (跑的紀錄[名稱]?.正在跑) return 回(res, 409, "text/plain; charset=utf-8", "這個鍵還在跑")
        const 紀 = 跑的紀錄[名稱] = { 正在跑: true, 開始: Date.now(), 輸出: "" }
        const 子 = spawn(String(鍵.指令), { cwd: directory, shell: true, windowsHide: true })
        const 收 = b => { 紀.輸出 = (紀.輸出 + b.toString()).slice(-6000) }
        子.stdout.on("data", 收); 子.stderr.on("data", 收)
        const 限 = setTimeout(() => { 收("\n（跑超過 15 分鐘，中控台把它停掉了）"); 子.kill() }, 15 * 60 * 1000)
        const 收尾 = async (碼, 錯) => {
          clearTimeout(限); if (!紀.正在跑) return
          if (錯) 收("\n" + 錯)
          紀.正在跑 = false; 紀.結束 = Date.now(); 紀.成功 = 碼 === 0
          try { await writeFile(join(directory, "公司", "按鍵紀錄.json"), JSON.stringify(跑的紀錄, null, 2)) } catch {}
        }
        子.on("close", 碼 => 收尾(碼)); 子.on("error", e => 收尾(1, "跑不起來：" + e.message))
        return 回JSON(res, { ok: true })
      }

      if (req.method === "GET" && 路.startsWith("/看/")) {
        const 相對 = 路.slice("/看/".length)
        const 段 = 相對.split(/[\\/]/)
        if (段.includes("..") || 段.some(x => x.startsWith("."))) return 回(res, 403, "text/plain; charset=utf-8", "不行")
        const 檔 = normalize(join(directory, 相對))
        if (!檔.startsWith(normalize(directory) + sep)) return 回(res, 403, "text/plain; charset=utf-8", "不行")
        try {
          const s = await stat(檔)
          if (!s.isFile()) return 回(res, 404, "text/plain; charset=utf-8", "不是檔案")
          res.writeHead(200, { "Content-Type": 型別[extname(檔).toLowerCase()] || "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Length": s.size })
          return res.end(await readFile(檔))
        } catch { return 回(res, 404, "text/plain; charset=utf-8", "資料夾裡沒有這個檔：" + 相對) }
      }

      if (req.method === "GET" && 路.startsWith("/成品/")) {
        const 相對 = 路.slice("/成品/".length)
        if (相對.split(/[\\/]/).includes("..")) return 回(res, 403, "text/plain; charset=utf-8", "不行")
        const 根 = join(directory, "成品")
        const 檔 = normalize(join(根, 相對))
        if (!檔.startsWith(根 + sep)) return 回(res, 403, "text/plain; charset=utf-8", "不行")
        try {
          const s = await stat(檔)
          if (!s.isFile()) return 回(res, 404, "text/plain; charset=utf-8", "不是檔案")
          const 型 = 型別[extname(檔).toLowerCase()] || "application/octet-stream"
          res.writeHead(200, { "Content-Type": 型, "Cache-Control": "no-store", "Content-Length": s.size })
          return res.end(await readFile(檔))
        } catch { return 回(res, 404, "text/plain; charset=utf-8", "成品櫃裡沒有這個檔：" + 相對) }
      }
      回(res, 404, "text/plain; charset=utf-8", "沒有這一頁")
    } catch (e) {
      回(res, 500, "text/plain; charset=utf-8", "中控台出錯：" + e)
    }
  })
  // 4777 被占了（例如另一個工作資料夾也開著），就往下找空的，最多試到 4796。實際網址寫進 公司/主控台網址.txt
  let 埠 = 起始埠
  const 開 = () => 伺服器.listen(埠, "127.0.0.1")
  伺服器.on("error", e => {
    if (e.code === "EADDRINUSE" && 埠 < 起始埠 + 19) { 埠 += 1; return 開() }
    記("warn", "中控台沒開成：" + e)
  })
  伺服器.on("listening", async () => {
    const 網址 = "http://127.0.0.1:" + 埠
    記("info", "中控台開在 " + 網址)
    try { await mkdir(join(directory, "公司"), { recursive: true }); await writeFile(join(directory, "公司", "主控台網址.txt"), 網址 + "\n") } catch {}
  })
  開()
  return {}
}

// 2026-11-14 加：這一版 OpenCode 的外掛介面整個換了（原本的具名輸出被拒載，錯誤：
// Plugin must export a default definition with an id and an effect or setup function），
// 而且這一版傳給外掛的資料裡沒有 directory（在 location.directory），也沒有 client 包裝
// （錯誤：paths[0] must be of type string）。所以這裡做一個轉接層：
// 1. directory 從 location 拿，找不到就用 process.cwd()
// 2. 自己兜一個跟舊版長得一樣的 client：送訊息、開對話、停對話直接轉到新的 session 功能；
//    讀對話、忙不忙改成聽事件（event.subscribe）自己收，因為這一版沒有 session.messages / session.status
// 3. 待辦（todo）這一版沒有，回空的；幫手（children）改從 session.list 找 parentID 一樣的對話
// 主控台 那個函式本體一字未改，只換它拿到的 client 與 directory。
export default {
  id: "主控台",
  setup: (c) => {
    const 取 = r => r?.data ?? r
    const 目錄 = c?.location?.directory ?? c?.directory ?? c?.project?.directory ?? process.cwd()
    // 錯誤要真的留得下來：寫進 公司/中控台log.txt（console 進不了紀錄檔，老闆看不到）
    const 寫log = (level, message) => {
      try {
        const 一行 = new Date().toISOString() + " [" + level + "] " + message + "\n"
        import("node:fs/promises").then(m => m.appendFile(join(目錄, "公司", "中控台log.txt"), 一行)).catch(() => {})
        console.error("[中控台]", level, message)
      } catch {}
    }

    // 舊版介面還在的話（以後可能有），直接用它的 client，不做事件轉接
    if (c?.client?.session?.messages) {
      return 主控台({ client: c.client, directory: 目錄 })
    }

    // 用事件自己收對話內容：sessionID -> 訊息編號 -> {info, parts}；另外記下每個對話的 parentID（幫手清單用）
    const 訊息庫 = new Map()
    const 子對話 = new Map()
    const 取庫 = id => { let m = 訊息庫.get(id); if (!m) { m = new Map(); 訊息庫.set(id, m) } return m }
    try {
      c.event?.subscribe?.(ev => {
        try {
          const 型 = String(ev?.type ?? "")
          const 內 = ev?.properties ?? ev ?? {}
          if (型 === "message.updated") {
            const info = 內.info
            if (info?.sessionID && info?.id) {
              const 庫 = 取庫(info.sessionID)
              const 舊 = 庫.get(info.id)
              庫.set(info.id, { info, parts: 舊?.parts || [] })
            }
          } else if (型 === "message.part.updated") {
            const p = 內.part ?? 內
            const sid = p?.sessionID ?? 內.sessionID, mid = p?.messageID ?? 內.messageID
            if (sid && mid) {
              const 庫 = 取庫(sid)
              const 條 = 庫.get(mid) || { info: { id: mid, sessionID: sid, role: 內.role || "assistant" }, parts: [] }
              const i = 條.parts.findIndex(x => x.id === p.id)
              if (i >= 0) 條.parts[i] = p; else 條.parts.push(p)
              庫.set(mid, 條)
            }
          } else if (型 === "message.part.removed") {
            const sid = 內.sessionID ?? 內.part?.sessionID, mid = 內.messageID ?? 內.part?.messageID
            if (sid && mid) {
              const 庫 = 取庫(sid), 條 = 庫.get(mid)
              if (條) 條.parts = 條.parts.filter(x => x.id !== (內.part?.id ?? 內.id))
            }
          } else if (型 === "message.removed") {
            const sid = 內.sessionID, mid = 內.messageID
            if (sid && mid) 取庫(sid).delete(mid)
          } else if (型 === "session.updated" || 型 === "session.created") {
            const info = 內.info ?? 內
            if (info?.id && info?.parentID) {
              if (!子對話.has(info.parentID)) 子對話.set(info.parentID, new Map())
              子對話.get(info.parentID).set(info.id, info)
            }
          }
        } catch {}
      })
    } catch {}

    const 排訊息 = id => [...取庫(id).values()]
      .filter(m => m.info?.role)
      .sort((a, b) => (a.info.time?.created || 0) - (b.info.time?.created || 0))

    // 這一版送訊息的格式跟舊版不一樣。一次試三種格式，哪一種成功用哪一種，失敗都記下來
    const 記錯 = 訊 => { try { 寫log("error", "送訊息失敗：" + 訊) } catch {} }
    const 轉送 = args => {
      const id = args?.path?.id ?? args?.params?.sessionID
      const 文字 = (args?.body?.parts ?? args?.payload?.parts ?? [])
        .filter(p => p?.type === "text").map(p => p.text).join("\n")
      const 模型 = args?.body?.model ?? args?.payload?.model
      // switchModel 只是前置（選頭腦），失敗不擋送訊息。11:08 實錯兩種：參數要平放、model 這一版用 {id, providerID}（DB 裡存的也是 id 這個鍵），輪流試到成功
      const 前置 = (模型 && 模型.providerID && c.session?.switchModel)
        ? (async () => {
            const 名 = 模型.modelID ?? 模型.id
            const 頭 = [{ id: 名, providerID: 模型.providerID }, { modelID: 名, providerID: 模型.providerID }]
            const 形 = []
            for (const m of 頭) {
              形.push(() => c.session.switchModel({ sessionID: id, model: m }))
              形.push(() => c.session.switchModel({ params: { sessionID: id }, payload: { model: m } }))
            }
            let 最後錯 = ""
            for (const 跑 of 形) {
              try { return await 跑() } catch (e) { 最後錯 = e?.message ?? e }
            }
            寫log("warn", "switchModel 失敗（不擋送訊息）：" + 最後錯)
          })()
        : null
      const 們 = [
        ["prompt:flat", () => c.session.prompt({ sessionID: id, text: 文字 })],
        ["prompt:params", () => c.session.prompt({ params: { sessionID: id }, payload: { text: 文字 } })],
        ["prompt:舊式", () => c.session.prompt({ path: { id }, body: { parts: [{ type: "text", text: 文字 }] } })],
      ]
      return (async () => {
        if (前置) await 前置
        let 最後錯 = ""
        for (const [名, 跑] of 們) {
          try {
            const 值 = await 跑()
            寫log("info", "送訊息成功（" + 名 + "）")
            return 值
          } catch (e) { 最後錯 = 名 + ": " + (e?.message ?? e) }
        }
        記錯(最後錯)
        throw new Error(最後錯)
      })()
    }

    const client = {
      app: { log: a => { 寫log(a?.body?.level ?? "?", a?.body?.message ?? ""); return Promise.resolve() } },
      session: {
        // 這一版的介面要「平放」的參數（11:08 實錯：Missing key at ["sessionID"]），出錯都記進 log
        呼: null,
        create: args => c.session.create({ title: args?.body?.title }).catch(e => { 寫log("error", "create 失敗：" + (e?.message ?? e)); throw e }),
        get: args => c.session.get({ sessionID: args?.path?.id ?? args?.sessionID }).catch(e => { 寫log("error", "get 失敗：" + (e?.message ?? e)); throw e }),
        // 這一版叫 interrupt，舊版叫 abort
        abort: args => c.session.interrupt({ sessionID: args?.path?.id }).catch(e => { 寫log("error", "interrupt 失敗：" + (e?.message ?? e)); throw e }),
        prompt: 轉送,
        promptAsync: 轉送,
        messages: async args => ({ data: 排訊息(args?.path?.id) }),
        status: async () => {
          const st = {}
          for (const [sid, 庫] of 訊息庫) {
            let 忙 = false
            for (const m of 庫.values()) {
              if (m.info?.role === "assistant" && !(m.info?.time?.completed)) 忙 = true
              for (const p of m.parts || []) { const pt = p.time || {}; if (pt.start && !pt.end) 忙 = true }
            }
            if (忙) st[sid] = { type: "busy" }
          }
          return { data: st }
        },
        todo: async () => ({ data: [] }),
        children: async args => ({ data: [...(子對話.get(args?.path?.id)?.values() || [])].map(s => ({ id: s.id, title: s.title })) }),
      },
    }
    return 主控台({ client, directory: 目錄 })
  },
}
