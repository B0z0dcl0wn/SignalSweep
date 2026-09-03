import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Geolocation } from '@capacitor/geolocation';
import { App } from '@capacitor/app';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Thin Capacitor shim: hang the plugins app.js needs on window before it runs.
// Geolocation is used ONLY on the consented one-shot pin path (getFix) and the
// map's manual Recenter -- never as a passive watch. Leaflet is back for the
// live map, but leaflet.offline deliberately is NOT: a persisted tile cache
// records which areas you downloaded, which is the sort of trail this app
// exists to not keep.
window.Capacitor = Capacitor;
window.BleClient = BleClient;
window.Geolocation = Geolocation;
window.App = App;
window.L = L;
