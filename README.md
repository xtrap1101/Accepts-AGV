# Auto Accept Agent v11.5.0 Pro

> Extension tự động chấp nhận code changes, terminal commands và completions cho Antigravity IDE — với cơ chế **Safety Check** chặn lệnh nguy hiểm.

## ✨ Tính năng

### 🚀 Auto Accept
- **Code changes** — Tự động accept code diffs, completions, inline suggestions
- **Terminal commands** — Tự động click "Run" cho terminal commands
- **Agent steps** — Accept agent steps, hunks, files tự động

### 🛡️ Safety Check (Terminal Commands)
- **Banned Commands** — Danh sách lệnh nguy hiểm mặc định, tự động chặn
- **CDP-based Detection** — Đọc nội dung lệnh từ dialog "Run command?" qua Chrome DevTools Protocol
- **Smart Blocking** — Lệnh an toàn → auto-run | Lệnh nguy hiểm → chờ user quyết định

### ⚡ Performance Optimized
- **Zero Layout Thrashing** — Sử dụng `offsetParent` thay vì `getComputedStyle`/`getBoundingClientRect`
- **Pre-compiled Regex** — Pattern matching nhanh, không tạo object mỗi vòng lặp
- **Configurable Polling** — Tần suất poll tùy chỉnh (mặc định 1000ms)

### 🔓 Pro Bypass
- Local pro activation — không cần license server

## 📋 Lệnh bị chặn mặc định

| Pattern | Mô tả |
|---|---|
| `rm -rf /` | Xóa toàn bộ hệ thống Linux |
| `rm -rf ~` | Xóa home directory |
| `rm -rf *` | Xóa toàn bộ thư mục hiện tại |
| `format c:` | Format ổ C Windows |
| `del /f /s /q` | Xóa bắt buộc Windows (CMD) |
| `del /f` | Xóa bắt buộc Windows |
| `rmdir /s /q` | Xóa thư mục bắt buộc |
| `Remove-Item` | Xóa PowerShell |
| `:(){:\|:&};:` | Fork bomb |
| `dd if=` | Ghi trực tiếp disk |
| `mkfs.` | Format filesystem |
| `> /dev/sda` | Ghi đè disk raw |
| `chmod -R 777 /` | Mở quyền toàn hệ thống |

> Tùy chỉnh: `Ctrl+Shift+P` → `Auto Accept: settings and pro`

## 🔧 Cài đặt

### Yêu cầu
- **Antigravity IDE** với CDP port enabled
- Shortcut Antigravity có flag: `--remote-debugging-port=9000`

### Setup CDP Port
```powershell
# Chạy script này 1 lần duy nhất trong PowerShell (Admin)
$WshShell = New-Object -ComObject WScript.Shell
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcuts = Get-ChildItem -Path $desktopPath -Filter "*.lnk" |
    Where-Object { $_.Name -like "*Antigravity*" }

foreach ($s in $shortcuts) {
    $shortcut = $WshShell.CreateShortcut($s.FullName)
    if ($shortcut.Arguments -notmatch '--remote-debugging-port') {
        $shortcut.Arguments = "--remote-debugging-port=9000 " + $shortcut.Arguments
        $shortcut.Save()
        Write-Host "Updated: $($s.Name)"
    }
}
```

### Cài Extension
1. Build (xem phần Build bên dưới) hoặc dùng file `.vsix` có sẵn
2. Trong Antigravity: `Ctrl+Shift+P` → `Install from VSIX...`
3. Chọn file `auto-accept-agent-11.5.0.vsix`
4. Reload window

## 🏗️ Build từ source

```powershell
cd extension

# 1. Bundle source
npx esbuild extension.js --bundle --outfile=dist/extension.js --external:vscode --platform=node --format=cjs

# 2. Package VSIX
npx -y @vscode/vsce package --no-dependencies

# Output: auto-accept-agent-11.5.0.vsix
```

## 📁 Cấu trúc project

```
extension/
├── extension.js              # Entry point — commands, activation, safety check
├── package.json              # Extension manifest
├── config.js                 # Configuration
├── settings-panel.js         # Settings UI panel
├── setup-panel.js            # Setup/onboarding UI
├── main_scripts/
│   ├── auto_accept.js        # DOM click logic (optimized)
│   ├── cdp-handler.js        # Chrome DevTools Protocol handler
│   ├── background_mode.js    # Background overlay mode
│   ├── compositor.js         # UI compositor
│   ├── relauncher.js         # Auto-relaunch logic
│   ├── selector_finder.js    # DOM selector discovery
│   ├── simple_poll.js        # Simple polling fallback
│   └── modules/              # Shared modules
├── dist/                     # Build output (generated)
└── media/                    # Icons and images
```

## ⚙️ Cấu hình

| Setting | Default | Mô tả |
|---|---|---|
| Poll Frequency | `1000ms` | Tần suất kiểm tra button (ms) |
| Banned Commands | 13 patterns | Danh sách lệnh nguy hiểm |
| Background Mode | `false` | Chế độ chạy ngầm |

## 🏛️ Kiến trúc

```
┌─────────────────────────────────────────────┐
│  Extension (extension.js)                    │
│  ├─ Accept Commands (VS Code API)           │
│  │   └─ Code diffs, completions, agent steps│
│  ├─ Terminal Run (with Safety Check)        │
│  │   ├─ CDP reads dialog text               │
│  │   ├─ Check against banned patterns       │
│  │   └─ Safe → Run | Banned → Block        │
│  └─ CDP Handler (cdp-handler.js)            │
│      ├─ Connect to IDE pages via port 9000  │
│      ├─ Inject auto_accept.js script        │
│      └─ getTerminalCommandText() for safety │
└─────────────────────────────────────────────┘
```

## 📄 License

Private use only.
