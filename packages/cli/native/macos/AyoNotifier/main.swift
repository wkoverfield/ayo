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

struct Ctx: Decodable { let ayoId: String?; let from: String?; let context: String? }
func decodeCtx(_ j: String?) -> Ctx? {
  j.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(Ctx.self, from: $0) }
}

let CATEGORY = "AYO_PING"

/** Append one action record as a JSON line (append is ~atomic, race-friendly).
 *  ctx + dir come from the NOTIFICATION (userInfo), so this works even when the
 *  helper is relaunched on click and argv is gone. */
func enqueueAction(_ action: String, ctx: Ctx?, dir: String) {
  var obj: [String: String] = ["action": action, "at": ISO8601DateFormatter().string(from: Date())]
  if let id = ctx?.ayoId { obj["ayoId"] = id }
  if let from = ctx?.from { obj["from"] = from }
  if let c = ctx?.context { obj["context"] = c }
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  let path = dir + "/action-queue.jsonl"
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  // POSIX O_APPEND: a single write() is atomic for records < PIPE_BUF, so two
  // helper instances clicking at once can't interleave/corrupt a JSONL line.
  let bytes = Array(line.utf8)
  let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
  if fd >= 0 {
    _ = bytes.withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
    close(fd)
  }
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching(_ note: Notification) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self // MUST be set before launch completes
    let copy = UNNotificationAction(identifier: "copy", title: "Copy context", options: [])
    let agent = UNNotificationAction(identifier: "agent", title: "\u{2192} My agent", options: [])
    center.setNotificationCategories([
      UNNotificationCategory(identifier: CATEGORY, actions: [copy, agent], intentIdentifiers: [], options: [])
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
      enqueueAction("agent", ctx: actionCtx, dir: dir)
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
