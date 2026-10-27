# Get current OS of user 
case "$(uname -s)" in
    Darwin*)
        # Run mac build when detected os is mac
        NODE_ENV=production npx electron-builder build --mac
        ;;
    Linux*)
        # Run linux build when detected os is Linux
        NODE_ENV=production npx electron-builder build --linux
        ;;
    MINGW*|MSYS*|CYGWIN*)
        # IDK if works but evil windows UGH
        NODE_ENV=production npx electron-builder build --win
        ;;
    *)
        echo "Unsupported operating system: $(uname -s)" >&2
        exit 1
        ;;
esac
# Start application 
NODE_ENV=production npx electron .