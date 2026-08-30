import re

def patch():
    with open('index.html', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Fix the `mode` typo in switchMode
    content = content.replace("document.getElementById('war-flocking-ui').style.display = mode === 2 ? 'flex' : 'none';", "document.getElementById('war-flocking-ui').style.display = modeInt === 2 ? 'flex' : 'none';")
    content = content.replace("if (mode === 2 && !map) {", "if (modeInt === 2 && !map) {")

    # 2. Add Fullscreen toggle button
    fullscreen_btn = """                <button id="btn-fullscreen-map" onclick="toggleMapFullscreen()" style="padding: 12px; border-radius: 8px; border: 1px solid var(--accent-cyan); background: transparent; color: var(--accent-cyan); font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; flex: 1;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
                    Toggle Fullscreen
                </button>
"""
    # Replace the existing export button to be in a row with the fullscreen button
    export_btn_old = """<button id="btn-export-osm" onclick="exportOSM()" style="padding: 12px; border-radius: 8px; border: none; background: linear-gradient(90deg, #00f2fe, #4facfe); color: #090d16; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Export .osm XML (DeFlock)
                </button>"""
    
    export_btn_new = """<div style="display: flex; gap: 10px; width: 100%;">
                <button id="btn-export-osm" onclick="exportOSM()" style="padding: 12px; border-radius: 8px; border: none; background: linear-gradient(90deg, #00f2fe, #4facfe); color: #090d16; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; flex: 1;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Export .osm
                </button>
""" + fullscreen_btn + "            </div>"
    
    content = content.replace(export_btn_old, export_btn_new)

    # 3. Add Fullscreen script logic
    fs_logic = """
        let isMapFullscreen = false;
        function toggleMapFullscreen() {
            const ui = document.getElementById('war-flocking-ui');
            const mapContainer = document.getElementById('map-container');
            
            if (!isMapFullscreen) {
                ui.style.position = 'fixed';
                ui.style.top = '0';
                ui.style.left = '0';
                ui.style.width = '100vw';
                ui.style.height = '100vh';
                ui.style.zIndex = '9999';
                ui.style.background = 'var(--bg-color)';
                ui.style.padding = '20px';
                ui.style.boxSizing = 'border-box';
                mapContainer.style.height = 'calc(100vh - 100px)';
                isMapFullscreen = true;
            } else {
                ui.style.position = 'static';
                ui.style.width = '100%';
                ui.style.height = 'auto';
                ui.style.zIndex = 'auto';
                ui.style.background = 'transparent';
                ui.style.padding = '0';
                mapContainer.style.height = '350px';
                isMapFullscreen = false;
            }
            if (map) {
                setTimeout(() => { map.invalidateSize(); }, 100);
            }
        }
    """
    content = content.replace("function exportOSM() {", fs_logic + "\n        function exportOSM() {")

    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(content)

if __name__ == '__main__':
    patch()
