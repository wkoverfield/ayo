// AyoNotifier — a tiny signed .app whose AppIcon is the Ayo mark, so macOS shows
// OUR logo on the toast instead of Script Editor's (osascript can't set an icon).
// The daemon (notify.ts) execs this with [title, body]; macOS attributes the
// notification to this bundle (dev.ayo.notifier) and renders its AppIcon.
//
// Usage: AyoNotifier "<title>" "<body>" [--sound]
// Exit:  0 posted · 2 not authorized · 3 post failed. (Useful when run directly;
//        notify.ts launches via `open`, which can't see these; it falls back to
//        osascript only if the launch itself fails, not on a post failure.)

import Foundation
import UserNotifications

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let args = CommandLine.arguments
let title = args.count > 1 ? args[1] : "Ayo"
let body = args.count > 2 ? args[2] : ""
// Scan only past the positional [path, title, body] so a body of "--sound" can't
// spuriously enable sound.
let wantSound = args.dropFirst(3).contains("--sound")

let center = UNUserNotificationCenter.current()

// Authorization is remembered per bundle id, so this only prompts the first run.
center.requestAuthorization(options: [.alert, .sound]) { granted, error in
  if let error = error { err("ayo-notifier: auth error: \(error.localizedDescription)") }
  guard granted else {
    err("ayo-notifier: notifications not authorized for dev.ayo.notifier")
    exit(2)
  }
  let content = UNMutableNotificationContent()
  content.title = title
  content.body = body
  if wantSound { content.sound = .default }
  let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  center.add(req) { addError in
    if let addError = addError {
      err("ayo-notifier: \(addError.localizedDescription)")
      exit(3)
    }
    // Give the system a beat to deliver before the process exits.
    Thread.sleep(forTimeInterval: 0.3)
    exit(0)
  }
}

// Keep the process alive for the async callbacks; exit() above ends it.
RunLoop.main.run()
