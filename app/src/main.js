import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Geolocation } from '@capacitor/geolocation';
import { App } from '@capacitor/app';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { tileLayerOffline, savetiles } from 'leaflet.offline';

window.Capacitor = Capacitor;
window.BleClient = BleClient;
window.Geolocation = Geolocation;
window.App = App;
window.L = L;
window.tileLayerOffline = tileLayerOffline;
window.savetiles = savetiles;
