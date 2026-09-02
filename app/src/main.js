import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Geolocation } from '@capacitor/geolocation';
import { App } from '@capacitor/app';

// Thin Capacitor shim: hang the plugins app.js needs on window before it runs.
// Geolocation is used ONLY on the consented one-shot pin path (getFix), never
// as a passive watch. Leaflet/the map were removed with the geospatial store.
window.Capacitor = Capacitor;
window.BleClient = BleClient;
window.Geolocation = Geolocation;
window.App = App;
