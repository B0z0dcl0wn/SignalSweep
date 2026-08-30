import re
import sys

def patch_html(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Add Capacitor module script
    if '<script type="module" src="/src/main.js"></script>' not in content:
        content = content.replace('</head>', '    <script type="module" src="/src/main.js"></script>\n</head>')

    # Remove onclick from the BLE connect button so our module can attach an event listener
    content = content.replace('onclick="connectWebBluetooth()"', 'id="btnWebBluetooth"')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

if __name__ == '__main__':
    patch_html(sys.argv[1])
