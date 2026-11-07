# [Development/build helper] Build for the host OS, then launch the app from source.
# This script is optional and is not part of packaged app runtime.
# Get current OS of user 
case "$(uname -s)" in
    Darwin*)
        # [macOS] Build a macOS release package.
        NODE_ENV=production npx electron-builder build --mac
        ;;
    Linux*)
        # [Linux] Build a Linux release package.
        NODE_ENV=production npx electron-builder build --linux
        ;;
    MINGW*|MSYS*|CYGWIN*)
        # [Windows shells] Attempt a Windows release build from Git Bash/MSYS/Cygwin.
        NODE_ENV=production npx electron-builder build --win
        ;;
    *)
        echo "Unsupported operating system: $(uname -s)" >&2
        exit 1
        ;;
esac
# Start application 
NODE_ENV=production npx electron .