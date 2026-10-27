# Build application 
case "$(uname -s)" in
    Darwin*)
        NODE_ENV=production npx electron-builder build --mac
        ;;
    Linux*)
        NODE_ENV=production npx electron-builder build --linux
        ;;
    MINGW*|MSYS*|CYGWIN*)
        NODE_ENV=production npx electron-builder build --win
        ;;
    *)
        echo "Unsupported operating system: $(uname -s)" >&2
        exit 1
        ;;
esac
# Start application 
NODE_ENV=production npx electron .