#!/bin/bash
# Double-click to start the QR ordering system (Mac)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Please install the LTS version from https://nodejs.org then run this file again."
  open https://nodejs.org
  read -r -p "Press Enter to close"
  exit 1
fi
[ -d node_modules ] || { echo "First run: installing, please wait..."; npm install; }
(sleep 3; open http://localhost:3000/staff) &
echo
echo "Keep this window open while the shop is open. Close it to stop the system."
echo
node server.js
