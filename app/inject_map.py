import re

def patch():
    with open('index.html', 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Rename Watcher's Watch to War Flocking
    content = content.replace("Watcher's Watch", "War Flocking")
    content = content.replace("Perimeter intrusion watchdog. Continuous probe request sniffer & BLE tracking for proximity alerts and unknown device tracking.", "GPS-enabled ALPR surveillance mapping. Logs Flock Safety ALPRs and visualizes detections on an OpenStreetMap interface.")
    content = content.replace("Perimeter Watch", "Surveillance Mapping")

    # 2. Inject Map HTML
    map_html = """
            <div id="war-flocking-ui" style="display: none; width: 100%; flex-direction: column; gap: 10px; margin-bottom: 20px;">
                <div id="map-container" style="width: 100%; height: 350px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1);"></div>
                <button id="btn-export-osm" onclick="exportOSM()" style="padding: 12px; border-radius: 8px; border: none; background: linear-gradient(90deg, #00f2fe, #4facfe); color: #090d16; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Export .osm XML (DeFlock)
                </button>
            </div>
"""
    content = content.replace('<div class="filter-container" id="bandit-filter-container"', map_html + '\n            <div class="filter-container" id="bandit-filter-container"')

    # 3. Add script logic for Map and Export
    script_logic = """
        let map = null;
        let polyline = null;
        let warFlockingPath = [];
        let warFlockingMarkers = {};

        function initMap() {
            if (!window.L) return;
            map = window.L.map('map-container').setView([0, 0], 15);
            window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap',
                maxZoom: 20
            }).addTo(map);
            polyline = window.L.polyline([], {color: '#00f2fe'}).addTo(map);
            
            if (window.Geolocation) {
                window.Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
                    if (pos && activeMode === 2) {
                        const latlng = [pos.coords.latitude, pos.coords.longitude];
                        warFlockingPath.push(latlng);
                        polyline.setLatLngs(warFlockingPath);
                        map.setView(latlng);
                    }
                });
            }
        }

        function exportOSM() {
            const targets = Object.values(trackedTargets);
            if (targets.length === 0) {
                showToast('No targets logged yet.', '✕');
                return;
            }

            let osm = `<?xml version='1.0' encoding='UTF-8'?>\\n<osm version="0.6" generator="SignalSweep">\\n`;
            let idCounter = -1; // Negative IDs for new elements

            targets.forEach(t => {
                const lat = warFlockingPath.length > 0 ? warFlockingPath[warFlockingPath.length-1][0] : 0;
                const lon = warFlockingPath.length > 0 ? warFlockingPath[warFlockingPath.length-1][1] : 0;
                
                osm += `  <node id="${idCounter}" lat="${lat}" lon="${lon}">\\n`;
                osm += `    <tag k="man_made" v="surveillance"/>\\n`;
                osm += `    <tag k="surveillance:type" v="ALPR"/>\\n`;
                osm += `    <tag k="manufacturer" v="Flock Safety"/>\\n`;
                osm += `    <tag k="name" v="${t.n || t.m}"/>\\n`;
                osm += `    <tag k="mac" v="${t.m}"/>\\n`;
                osm += `  </node>\\n`;
                idCounter--;
            });

            osm += `</osm>`;
            
            const element = document.createElement('a');
            element.setAttribute('href', 'data:text/xml;charset=utf-8,' + encodeURIComponent(osm));
            element.setAttribute('download', `flock_targets_${new Date().getTime()}.osm`);
            element.style.display = 'none';
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
            showToast('OSM Export Downloaded!', '✓');
        }
"""
    content = content.replace('let bleDevice = null;', script_logic + '\n        let bleDevice = null;')

    # 4. Show/Hide War Flocking UI on mode switch
    switch_logic = """
            document.getElementById('war-flocking-ui').style.display = mode === 2 ? 'flex' : 'none';
            if (mode === 2 && !map) {
                setTimeout(initMap, 100);
            }
"""
    content = content.replace("document.getElementById('bandit-filter-container').style.display = mode === 1 ? 'flex' : 'none';", switch_logic + "\n            document.getElementById('bandit-filter-container').style.display = mode === 1 ? 'flex' : 'none';")

    # 5. Inject leaflet into <head>
    head_inject = """    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
"""
    content = content.replace('</title>', '</title>\n' + head_inject)
    
    with open('index.html', 'w', encoding='utf-8') as f:
        f.write(content)

if __name__ == '__main__':
    patch()
