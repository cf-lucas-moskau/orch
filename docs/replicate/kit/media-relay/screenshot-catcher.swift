// Main Mac launchd agent: copies screenshots dragged from the floating thumbnail
// (which macOS only keeps in $TMPDIR/TemporaryItems/NSIRD_screencaptureui_*) into
// ~/Screenshots so Syncthing mirrors them to the host. Needs Full Disk Access.
// Build: swiftc -O screenshot-catcher.swift -o ~/.local/bin/screenshot-catcher
import Foundation

let fm = FileManager.default
let env = ProcessInfo.processInfo.environment
let tmp = env["CATCHER_TMP"] ?? NSTemporaryDirectory() + "TemporaryItems"
let dest = env["CATCHER_DEST"] ?? NSHomeDirectory() + "/Screenshots"
let media: Set<String> = ["png", "jpg", "jpeg", "heic", "tiff", "gif", "pdf", "mov", "mp4"]

if CommandLine.arguments.contains("--check") {
    do { _ = try fm.contentsOfDirectory(atPath: tmp); print("ok \(tmp)"); exit(0) }
    catch { print("denied \(tmp): \(error.localizedDescription)"); exit(1) }
}

while true {
    for d in (try? fm.contentsOfDirectory(atPath: tmp)) ?? [] where d.hasPrefix("NSIRD_screencaptureui_") {
        let dir = tmp + "/" + d
        for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? []
        where media.contains((f as NSString).pathExtension.lowercased()) {
            let target = dest + "/" + f
            if fm.fileExists(atPath: target) { continue }
            let part = dest + "/.part-" + f
            try? fm.removeItem(atPath: part)
            if (try? fm.copyItem(atPath: dir + "/" + f, toPath: part)) != nil {
                try? fm.moveItem(atPath: part, toPath: target)
            }
        }
    }
    Thread.sleep(forTimeInterval: 0.3)
}
