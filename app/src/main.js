// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Geolocation } from '@capacitor/geolocation';
import { App } from '@capacitor/app';
import { UsbSerial } from '@leeskies/capacitor-usb-serial';
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
// Android has no WebSerial -- the API is simply absent from the platform, not
// gated behind a flag -- so driving the device over the cable from a phone
// needs the USB host stack directly. On web this import resolves to a stub
// that rejects every call with UNSUPPORTED_PLATFORM, which is why app.js picks
// the transport by platform rather than by whether this object exists.
window.UsbSerial = UsbSerial;
window.L = L;
