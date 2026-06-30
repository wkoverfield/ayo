// AyoNotifier — a signed .app whose AppIcon is the Ayo mark, so macOS shows OUR
// logo on the toast (osascript can't set an icon). It also makes the toast
// ACTIONABLE: the daemon (notify.ts) execs it with the Ayo's context, and the
// helper stays alive until the user clicks (or a timeout) — the alerter/NotifiCLI
// model. On click it copies context / pipes it into the user's coding agent, then
// exits. A bare-exec'd binary can't own notifications, so notify.ts launches it
// via `open -g Ayo.app --args ...`.
//
// Args: <title> <body> [--sound] [--ctx <json>] [--ayo-dir <path>]
//   --ctx JSON: { "ayoId": "...", "from": "...", "context": "<text to copy/pipe>" }
// Actions: body-click or "→ My agent" -> append to <ayo-dir>/action-queue.jsonl
//          (the agent hook drains it); "Copy context" -> clipboard.

import AppKit
import Foundation
import UserNotifications

let args = CommandLine.arguments
func argValue(_ flag: String) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}
func errLog(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let title = args.count > 1 ? args[1] : "Ayo"
let body = args.count > 2 ? args[2] : ""
let wantSound = args.dropFirst(3).contains("--sound")
let ctxJSON = argValue("--ctx")
let ayoDir = argValue("--ayo-dir") ?? (NSHomeDirectory() + "/.ayo")

struct Ctx: Decodable {
  let ayoId: String?
  let from: String?
  let context: String?
  let repo: String? // for route-by-repo to the right agent session
  let relayUrl: String? // non-secret; for Reply/Resolve HTTP
  let teamId: String?
}
func decodeCtx(_ j: String?) -> Ctx? {
  j.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(Ctx.self, from: $0) }
}

let CATEGORY = "AYO_PING"

/** Read the session token from disk (NOT argv) so it never leaks via process args. */
func readToken(_ dir: String) -> String? {
  guard let data = FileManager.default.contents(atPath: dir + "/session.json"),
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
  return obj["token"] as? String
}

/** Fire a POST and wait briefly (the helper exits right after). */
func httpPost(_ urlStr: String, json: [String: Any]?, token: String) {
  guard let url = URL(string: urlStr) else { return }
  var req = URLRequest(url: url)
  req.httpMethod = "POST"
  req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  if let json = json {
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: json)
  }
  let sema = DispatchSemaphore(value: 0)
  URLSession.shared.dataTask(with: req) { _, _, _ in sema.signal() }.resume()
  _ = sema.wait(timeout: .now() + 5)
}

func sendReply(_ text: String, ctx: Ctx?, dir: String) {
  guard let to = ctx?.from, let relay = ctx?.relayUrl, let team = ctx?.teamId, let token = readToken(dir) else { return }
  httpPost(relay + "/v1/teams/" + team + "/ayo", json: ["to": [to], "body": text], token: token)
}

func resolveAyo(ctx: Ctx?, dir: String) {
  guard let id = ctx?.ayoId, let relay = ctx?.relayUrl, let token = readToken(dir) else { return }
  httpPost(relay + "/v1/ayo/" + id + "/resolve", json: nil, token: token)
}

/** Drop a clicked ping as a unique file in <dir>/pending/ for the agent hook to
 *  route + claim (route-by-repo). ctx + dir come from the NOTIFICATION (userInfo),
 *  so this works even on a relaunch-on-click where argv is gone. A unique filename
 *  means no concurrent-write contention. */
func enqueuePending(ctx: Ctx?, dir: String) {
  var obj: [String: String] = ["at": ISO8601DateFormatter().string(from: Date())]
  if let id = ctx?.ayoId { obj["ayoId"] = id }
  if let from = ctx?.from { obj["from"] = from }
  if let c = ctx?.context { obj["context"] = c }
  if let r = ctx?.repo { obj["repo"] = r }
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  let pendingDir = dir + "/pending"
  try? FileManager.default.createDirectory(atPath: pendingDir, withIntermediateDirectories: true)
  try? data.write(to: URL(fileURLWithPath: pendingDir + "/" + UUID().uuidString + ".json"))
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching(_ note: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self // MUST be set before launch completes
    let agent = UNNotificationAction(identifier: "agent", title: "\u{2192} My agent", options: [])
    let reply = UNTextInputNotificationAction(
      identifier: "reply", title: "Reply", options: [],
      textInputButtonTitle: "Send", textInputPlaceholder: "Reply\u{2026}"
    )
    let copy = UNNotificationAction(identifier: "copy", title: "Copy context", options: [])
    let resolve = UNNotificationAction(identifier: "resolve", title: "Resolve", options: [])
    // Banner shows ~2 as buttons; the rest in the expanded menu. macOS limit is 4.
    center.setNotificationCategories([
      UNNotificationCategory(identifier: CATEGORY, actions: [agent, reply, copy, resolve], intentIdentifiers: [], options: [])
    ])
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      // These callbacks run on a background queue; bounce exit() to main so it
      // can't race AppKit teardown on the main thread.
      if let error = error { errLog("ayo-notifier: auth: \(error.localizedDescription)") }
      guard granted else { DispatchQueue.main.async { exit(2) }; return }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      if wantSound { content.sound = .default }
      content.categoryIdentifier = CATEGORY
      // Stash everything the click handler needs in userInfo — it survives a
      // relaunch (when macOS reopens us to handle a click and argv is gone).
      content.userInfo = ["ctx": ctxJSON ?? "", "ayoDir": ayoDir]
      let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
      center.add(req) { addErr in
        if let addErr = addErr {
          errLog("ayo-notifier: \(addErr.localizedDescription)")
          DispatchQueue.main.async { exit(3) }
        }
      }
      // Stay alive to receive the click. After a while, exit so we don't linger —
      // the toast stays in Notification Center, and a later click MAY relaunch us
      // (best-effort; if it does, context is recovered from the notification's
      // userInfo since argv is gone on a relaunch).
      DispatchQueue.main.asyncAfter(deadline: .now() + 90) { exit(0) }
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    // Pull context from the notification (works on a relaunch where argv is gone);
    // fall back to argv for the still-alive case.
    let info = response.notification.request.content.userInfo
    let actionCtx = decodeCtx(info["ctx"] as? String) ?? decodeCtx(ctxJSON)
    let dir = (info["ayoDir"] as? String) ?? ayoDir
    switch response.actionIdentifier {
    case "copy":
      if let text = actionCtx?.context {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
      }
    case "agent", UNNotificationDefaultActionIdentifier: // body-click pipes to the agent
      enqueuePending(ctx: actionCtx, dir: dir)
    case "reply":
      if let text = (response as? UNTextInputNotificationResponse)?.userText,
         !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        sendReply(text, ctx: actionCtx, dir: dir)
      }
    case "resolve":
      resolveAyo(ctx: actionCtx, dir: dir)
    default: // dismiss / unknown
      break
    }
    completionHandler()
    exit(0)
  }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon (matches LSUIElement)
app.run()
