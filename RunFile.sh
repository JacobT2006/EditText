#!/bin/bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR" || exit 1

show_menu() {
    if command -v osascript >/dev/null 2>&1; then
        osascript <<'APPLESCRIPT'
        tell application "System Events"
            set result to button returned of (display dialog "Choose how to run EditText" buttons {"Start Electron", "Build Production", "Windows Preview", "Cancel"} default button "Start Electron" with title "EditText Launcher")
        end tell
APPLESCRIPT
        return
    fi

    if command -v zenity >/dev/null 2>&1; then
        CHOICE=$(zenity --title="EditText Launcher" --width=460 --height=220 --list --radiolist --column "Select" --column "Action" TRUE "Start Electron" FALSE "Build Production" FALSE "Windows Preview" FALSE "Cancel" 2>/dev/null)
        if [ -n "$CHOICE" ]; then
            printf '%s\n' "$CHOICE"
            return
        fi
    fi

    echo "Choose an action:"
    echo "1) Start Electron"
    echo "2) Build Production"
    echo "3) Windows Preview"
    echo "4) Cancel"
    read -r CHOICE
    printf '%s\n' "$CHOICE"
}

run_start_electron() {
    echo "Launching EditText in development mode..."
    npm start
}

run_build_production() {
    echo "Building production app..."
    npm run build:prod
}

run_windows_preview() {
    PORT=8081
    URL="http://localhost:${PORT}/test/preview.html"

    if ! command -v python3 >/dev/null 2>&1; then
        echo "Python 3 is required to run the Windows browser preview." >&2
        exit 1
    fi

    echo "Starting the Windows-style web preview..."
    if command -v python3 >/dev/null 2>&1; then
        (python3 -m http.server "$PORT" > /tmp/edittext-preview.log 2>&1 &)
    fi

    sleep 2

    case "$(uname -s)" in
        Darwin*)
            open "$URL"
            ;;
        Linux*)
            if command -v xdg-open >/dev/null 2>&1; then
                xdg-open "$URL"
            else
                echo "Open this in a browser: $URL"
            fi
            ;;
        *)
            echo "Open this in a browser: $URL"
            ;;
    esac

    echo "Windows preview is running at $URL"
    echo "Press Ctrl+C in the server terminal to stop it."
}

ACTION=$(show_menu)

case "$ACTION" in
    "Start Electron"|"1")
        run_start_electron
        ;;
    "Build Production"|"2")
        run_build_production
        ;;
    "Windows Preview"|"3")
        run_windows_preview
        ;;
    "Cancel"|"4"|"")
        echo "Cancelled."
        exit 0
        ;;
    *)
        echo "Unknown action: $ACTION"
        exit 1
        ;;
esac