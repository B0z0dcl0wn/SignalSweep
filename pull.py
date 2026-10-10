#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors
"""Pull your data off a SignalSweep board over a USB cable. No browser, no network.

Saves one folder:
  alerts.txt     what the board alerted on, readable, oldest first
  report.html    the same, as a page you can sort and filter (opens offline)
  CAP*.pcap      each packet capture on the card, for Wireshark (Wi-Fi frames)
  raw/           the untouched originals: card files + the flash log as CSV
The card never has to leave the case.

  python pull.py                       # finds the board, saves to ./SignalSweep-<time>/
  python pull.py --port COM4 --out D:/case
  python pull.py --wipe                # then delete each card file that copied intact
  python pull.py --phone               # also copy the app's files off an Android phone (adb)
  python pull.py --pcap CAP00012.SSC   # just convert a capture you already have
  python pull.py --selftest

Needs pyserial (pip install pyserial). --phone needs adb on PATH.

This file is deliberately self-contained (no imports from the rest of the repo)
so it can be read top to bottom before you run it.
"""
import argparse
import base64
import csv
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone

ESP_VID = 0x303A
CARD_NAME = re.compile(r"^[A-Z0-9]{1,8}\.[A-Z0-9]{1,3}$")   # sd_store.cpp only writes 8.3 names
LOG_REC = 16                                               # alert_log.h record size
CATS = ["ALPR/Camera", "Body cam", "Drone", "Tracker", "Other"]   # AlertCategory order
CAP_HDR = struct.Struct("<BIIBbHH")                        # mode_capture.cpp record header
PHONE_DIR = "/sdcard/Documents"                            # Capacitor Directory.Documents


def die(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------
#  Serial link: one line in, lines out. The board's 1 Hz telemetry push and
#  its boot banner share the port; everything below picks lines by prefix.
# --------------------------------------------------------------------------
class Link:
    def __init__(self, port):
        import serial
        self.ser = serial.Serial()
        self.ser.port, self.ser.baudrate, self.ser.timeout = port, 115200, 0.1
        # Low BEFORE open: raised, Windows drops them when this exits and the
        # C5's USB-Serial-JTAG resets the board.
        self.ser.dtr = False
        self.ser.rts = False
        try:
            self.ser.open()
        except serial.SerialException as e:
            die("could not open %s: %s\nIf it says access denied, another program has the port: "
                "close the SignalSweep app or pull page in Chrome, any serial monitor, "
                "or another script, then try again." % (port, e))
        self.buf = b""

    def lines(self, timeout):
        end = time.time() + timeout
        while time.time() < end:
            # Whatever has arrived, else wait for 1 byte: read(4096) sat out the
            # full timeout at the end of every page, ~100 ms per 6 KB.
            self.buf += self.ser.read(max(1, self.ser.in_waiting))
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                yield line.decode("utf-8", "replace").strip()

    def send(self, cmd):
        self.ser.write((cmd + "\n").encode())
        self.ser.flush()


def frame(line, key):
    """The JSON object under `key` if this line is that reply, else None."""
    if not line.startswith('{"%s"' % key):
        return None
    try:
        return json.loads(line)[key]
    except ValueError:
        return None


def card_list(link):
    # Opening the port can reset the board; ask again until it answers.
    for _ in range(4):
        link.send("CMD:SD:LS")
        for line in link.lines(3):
            o = frame(line, "sdls")
            if o is not None:
                return o
    return None


def card_get(link, name, size):
    """Whole file, page by page. Each page is re-asked if the bytes that
    decoded do not add up to what the board says it sent."""
    data, off = bytearray(), 0
    while True:
        for attempt in range(4):
            link.send("CMD:SD:GET:%s:%d" % (name, off))
            page, hdr, done, err = bytearray(), False, None, None
            for line in link.lines(8):
                if line.startswith("SDF:") and hdr:
                    try:
                        page += base64.b64decode(line[4:], validate=True)
                    except ValueError:
                        break               # torn line: re-ask the page
                    continue
                o = frame(line, "sdget")
                if o is None:
                    continue
                if o.get("err"):
                    err = o["err"]; break
                if "size" in o and o.get("off") == off:
                    hdr = True
                elif o.get("done") and hdr and o.get("off", off) == off:
                    done = o; break
            if err:
                return None, err
            if done and len(page) == done["next"] - off:
                break
        else:
            return None, "page at %d kept failing" % off
        data += page
        off = done["next"]
        if not done.get("more"):
            break
    if len(data) != size:
        return None, "got %d of %d bytes" % (len(data), size)
    return bytes(data), None


def card_rm(link, name):
    link.send("CMD:SD:RM:" + name)
    for line in link.lines(5):
        o = frame(line, "sdrm")
        if o is not None and o.get("err"):
            return o["err"]
        if frame(line, "sdls") is not None:
            return None          # success answers with a fresh listing
    return "no reply"


def read_alert_log(link):
    """Every record in the board's flash ring -> (records, names, epochs)."""
    recs, names, epochs, skip, tries = [], [], {}, 0, 0
    while True:
        tries += 1
        if tries > 4:
            die("alert log page at record %d kept failing" % skip)
        link.send("CMD:LOG:READ:0:0:%d" % skip)
        blob, hdr, more, ended = b"", None, False, False
        for line in link.lines(10):
            if line.startswith("LOG:") and hdr is not None:
                try:
                    blob += base64.b64decode(line[4:], validate=True)
                except ValueError:
                    pass
                continue
            o = frame(line, "logrd")
            if o is None:
                continue
            if o.get("err"):
                die("board could not read its log: " + o["err"])
            if o.get("done"):
                ended = True; break
            if o.get("skip") == skip:
                hdr = o
                more = bool(o.get("more"))
                if "names" in o:
                    names = [n for n in o["names"].split("\n") if n]
                epochs.update({int(k): v for k, v in o.get("epochs", {}).items()})
        if hdr is None or not ended:
            continue                 # reset on open, or a lost frame: ask again
        page = [blob[i:i + LOG_REC] for i in range(0, len(blob) - LOG_REC + 1, LOG_REC)]
        if len(page) != hdr.get("n", len(page)):
            continue                 # lost a line: ask for this page again
        recs += page
        tries = 0
        if not more or not page:
            return recs, names, epochs
        skip += len(page)


def log_rows(recs, names, epochs):
    """Records -> [unix time or None, boot, secs, mac, category, rule, dBm], oldest first.
    The boot counter only goes up, so (boot, secs) is the order even for undated boots."""
    rows = []
    for r in recs:
        boot, secs = struct.unpack_from("<HI", r, 0)
        cat, rule = r[12], r[13]
        rows.append([epochs[boot] + secs if boot in epochs else None, boot, secs,
                     ":".join("%02x" % b for b in r[6:12]),
                     CATS[cat] if cat < len(CATS) else str(cat),
                     names[rule] if rule < len(names) else str(rule),
                     struct.unpack_from("<b", r, 14)[0]])
    rows.sort(key=lambda x: (x[1], x[2]))
    return rows


def alert_log_csv(rows, out):
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["utc", "boot", "secs", "mac", "category", "rule", "rssi"])
        for t, boot, secs, mac, cat, rule, rssi in rows:
            utc = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t is not None else ""
            w.writerow([utc, boot, secs, mac, cat, rule, rssi])


def when(t, boot, secs):
    """Local wall-clock time, or the boot-relative time when that boot was never dated."""
    if t is not None:
        return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")
    return "boot %d +%d:%02d:%02d" % (boot, secs // 3600, secs // 60 % 60, secs % 60)


def alerts_txt(rows, made):
    """The human-readable report. pull.html's alertsTxt() writes the same text."""
    out = ["SignalSweep export, made %s. Times are this computer's local time." % made, ""]
    if not rows:
        out += ["The board's alert log is empty. It is off by default: in the app,",
                "Settings > Recording > Log alerts on the board (or Record on the Sweep screen)."]
        return "\n".join(out) + "\n"
    out += ["%d alert(s) from the board's own log, boots %d to %d." % (len(rows), rows[0][1], rows[-1][1]), "",
            "What it heard"]
    for c in CATS + sorted({r[4] for r in rows} - set(CATS)):
        rules = {}
        for r in rows:
            if r[4] == c:
                rules[r[5]] = rules.get(r[5], 0) + 1
        if rules:
            top = sorted(rules.items(), key=lambda kv: (-kv[1], kv[0]))
            desc = ", ".join("%s %d" % kv for kv in top[:3]) + (", +%d more" % (len(top) - 3) if len(top) > 3 else "")
            out.append("  %-12s %6d  %s" % (c, sum(rules.values()), desc))
    out += ["", "Every alert, oldest first",
            "%-19s  %-12s %4s  %-17s  %s" % ("time", "category", "dBm", "mac", "rule")]
    for t, boot, secs, mac, cat, rule, rssi in rows:
        out.append("%-19s  %-12s %4d  %-17s  %s" % (when(t, boot, secs), cat, rssi, mac, rule))
    return "\n".join(out) + "\n"


# The browsable report: one self-contained page, data inlined, nothing fetched.
# pull.html carries this template byte for byte (test_distribution.py checks).
REPORT_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>SignalSweep alerts</title>
<style>
:root{color-scheme:dark;--bg:#0f1218;--fg:#e6e9ef;--dim:#8a93a3;--line:#262c38;--acc:#4fd18b}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#fff;--fg:#1a1d24;--dim:#5b6372;--line:#dde1e8;--acc:#1a8f55}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:1.3rem;margin:.2rem 0}.dim{color:var(--dim)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.chip{border:1px solid var(--line);background:none;color:inherit;border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit}
.chip.on{border-color:var(--acc);color:var(--acc)}
input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:none;color:inherit;font:inherit;margin-bottom:8px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg)}
td.n{text-align:right}td.m{font-family:ui-monospace,Consolas,monospace}
</style></head><body><main>
<h1>SignalSweep alerts</h1>
<p class="dim" id="sub"></p>
<div class="chips" id="chips"></div>
<input id="q" type="search" placeholder="Filter by rule, MAC or category">
<div class="wrap"><table><thead><tr><th data-k="0">Time</th><th data-k="4">Category</th><th data-k="5">Rule</th><th data-k="6">dBm</th><th data-k="3">MAC</th></tr></thead><tbody id="tb"></tbody></table></div>
<p class="dim" id="more"></p>
</main>
<script type="application/json" id="d">__DATA__</script>
<script>
var D = JSON.parse(document.getElementById('d').textContent), R = D.rows, cat = '', key = 0, dir = 1, MAX = 2000;
function $(i) { return document.getElementById(i); }
function two(n) { return (n < 10 ? '0' : '') + n; }
function when(r) {
  if (r[0] === null) return 'boot ' + r[1] + ' +' + Math.floor(r[2] / 3600) + ':' + two(Math.floor(r[2] / 60) % 60) + ':' + two(r[2] % 60);
  var d = new Date(r[0] * 1000);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}
function cmp(a, b) {
  if (key === 0) return dir * (a[1] - b[1] || a[2] - b[2]);
  var x = a[key], y = b[key];
  return dir * (typeof x === 'number' ? x - y : String(x).localeCompare(String(y)));
}
function draw() {
  var q = $('q').value.toLowerCase(), rows = R.filter(function (r) {
    return (!cat || r[4] === cat) && (!q || (r[3] + ' ' + r[4] + ' ' + r[5]).toLowerCase().indexOf(q) >= 0);
  }).sort(cmp), tb = $('tb'), f = document.createDocumentFragment();
  rows.slice(0, MAX).forEach(function (r) {
    var tr = document.createElement('tr');
    [[when(r), ''], [r[4], ''], [r[5], ''], [r[6], 'n'], [r[3], 'm']].forEach(function (c) {
      var td = document.createElement('td'); td.textContent = c[0]; td.className = c[1]; tr.appendChild(td);
    });
    f.appendChild(tr);
  });
  tb.textContent = ''; tb.appendChild(f);
  $('more').textContent = rows.length > MAX ? 'Showing ' + MAX + ' of ' + rows.length + '. Filter to narrow it down.' : rows.length + ' shown.';
}
$('sub').textContent = R.length ? R.length + " alert(s) from the board's own log. Exported " + D.made + ". Times are local to whoever opens this page."
  : "The board's alert log is empty. It is off by default: in the app, Settings > Recording > Log alerts on the board.";
var counts = {};
R.forEach(function (r) { counts[r[4]] = (counts[r[4]] || 0) + 1; });
[''].concat(Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })).forEach(function (c) {
  var b = document.createElement('button'); b.className = 'chip' + (c === '' ? ' on' : '');
  b.textContent = c === '' ? 'All ' + R.length : c + ' ' + counts[c];
  b.onclick = function () {
    cat = c; document.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('on', x === b); }); draw();
  };
  $('chips').appendChild(b);
});
document.querySelectorAll('th').forEach(function (th) {
  th.onclick = function () { var k = +th.dataset.k; dir = k === key ? -dir : 1; key = k; draw(); };
});
$('q').oninput = draw;
draw();
</script></body></html>
"""


def report_html(rows, made):
    # "<" escaped so a rule name (device-chosen: a pwnagotchi names itself) can never close the script.
    return REPORT_HTML.replace("__DATA__", json.dumps({"made": made, "rows": rows}).replace("<", "\\u003c"))


def write_reports(rows, out, raw):
    made = datetime.now().strftime("%Y-%m-%d %H:%M")
    alert_log_csv(rows, os.path.join(raw, "alert-log.csv"))
    with open(os.path.join(out, "alerts.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(alerts_txt(rows, made))
    with open(os.path.join(out, "report.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(report_html(rows, made))


# --------------------------------------------------------------------------
#  .sscap -> pcap. Wi-Fi frames only, with a radiotap header so Wireshark
#  shows channel and signal. BLE adverts are not written (different link type).
# --------------------------------------------------------------------------
def sscap_to_pcap(text, out):
    n = 0
    with open(out, "wb") as f:
        f.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 127))
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                blob = base64.b64decode(line, validate=True)
            except ValueError:
                continue
            if len(blob) < CAP_HDR.size:
                continue
            radio, _seq, ts, ch, rssi, olen, clen = CAP_HDR.unpack_from(blob)
            if radio != 0:
                continue
            ch = ch or 1
            freq, cflags = (5000 + 5 * ch, 0x0140) if ch > 14 else (2407 + 5 * ch, 0x00A0)
            rt = struct.pack("<BBHIHHb", 0, 0, 13, (1 << 3) | (1 << 5), freq, cflags, rssi)
            # The ESP32 hands over each frame with 4 trailing FCS bytes that are
            # not a valid CRC; left in, Wireshark reads them as a junk IE on
            # nearly every beacon. A truncated record never reached them.
            flen = max(olen - 4, 0)
            pkt = rt + blob[CAP_HDR.size:CAP_HDR.size + min(clen, flen)]
            f.write(struct.pack("<IIII", ts // 1000000, ts % 1000000, len(pkt), 13 + flen))
            f.write(pkt)
            n += 1
    return n


# --------------------------------------------------------------------------
#  Choosing hardware: never guess between two.
# --------------------------------------------------------------------------
def choose(items, label, fmt):
    if not items:
        die("no %s found" % label)
    if len(items) == 1:
        return items[0]
    print("\nMore than one %s attached:" % label)
    for i, it in enumerate(items, 1):
        print("  [%d] %s" % (i, fmt(it)))
    while True:
        pick = input("Which %s? [1-%d] " % (label, len(items))).strip()
        if pick.isdigit() and 1 <= int(pick) <= len(items):
            return items[int(pick) - 1]


def pick_port():
    try:
        from serial.tools import list_ports
    except ImportError:
        die("pyserial is needed: pip install pyserial")
    ports = [p for p in list_ports.comports() if p.vid == ESP_VID]
    return choose(ports, "board", lambda p: "%s  %s" % (p.device, p.serial_number or "")).device


def pull_phone(out):
    adb = shutil.which("adb")
    if not adb:
        die("adb is not on PATH (Android platform-tools)")
    run = lambda *a: subprocess.run([adb, *a], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    devs = [l.split()[0] for l in run("devices").stdout.splitlines()[1:] if l.strip().endswith("device")]
    serial = choose(devs, "phone", str)
    names = [n for n in run("-s", serial, "shell", "ls", "-1", PHONE_DIR).stdout.split()
             if n.startswith("signalsweep-")]
    dest = os.path.join(out, "phone")
    os.makedirs(dest, exist_ok=True)
    for n in names:
        r = run("-s", serial, "pull", PHONE_DIR + "/" + n, dest)
        print("  phone  %-50s %s" % (n, "ok" if r.returncode == 0 else r.stderr.strip()))
    print("  phone  %d item(s). Saved pins and photo finds stay encrypted in the app;"
          " export them from the app with your PIN." % len(names))


def selftest():
    import tempfile
    rec = struct.pack("<HI6sBBb", 3, 120, bytes.fromhex("aabbccddeeff"), 2, 1, -61) + b"\0"
    assert len(rec) == LOG_REC
    d = tempfile.mkdtemp()
    undated = struct.pack("<HI6sBBb", 2, 3725, bytes(6), 0, 0, -70) + b"\0"
    rows = log_rows([rec, undated], ["Flock", "Remote ID"], {3: 1700000000})
    assert [r[1] for r in rows] == [2, 3]                    # oldest boot first
    p = os.path.join(d, "a.csv")
    alert_log_csv(rows, p)
    with open(p, newline="") as f:
        row = list(csv.reader(f))[2]
    assert row == ["2023-11-14T22:15:20Z", "3", "120", "aa:bb:cc:dd:ee:ff", "Drone", "Remote ID", "-61"], row
    txt = alerts_txt(rows, "now")
    assert "2 alert(s)" in txt and "boot 2 +1:02:05" in txt and "Drone             1  Remote ID 1" in txt, txt
    assert "is empty" in alerts_txt([], "now")
    rows[0][5] = "</script><b>"                              # a device-chosen name must stay data
    html = report_html(rows, "now")
    assert "</script><b>" not in html and html.count("</script>") == 2
    assert json.loads(html.split('id="d">')[1].split("</script>")[0])["rows"][0][5] == "</script><b>"
    frame80211 = bytes([0x80, 0]) + bytes(22)
    cap = CAP_HDR.pack(0, 1, 2500000, 36, -40, len(frame80211) + 4, len(frame80211) + 4) + frame80211 + b"FCS!"
    ble = CAP_HDR.pack(1, 2, 0, 0, -50, 7, 7) + bytes(7)
    text = "#SSCAP v1\n" + base64.b64encode(cap).decode() + "\n" + base64.b64encode(ble).decode() + "\n"
    p = os.path.join(d, "a.pcap")
    assert sscap_to_pcap(text, p) == 1
    raw = open(p, "rb").read()
    sec, usec, ln, orig = struct.unpack_from("<IIII", raw, 24)
    assert (sec, usec, ln, orig) == (2, 500000, 13 + len(frame80211), 13 + len(frame80211))
    assert raw[40 + 13:] == frame80211          # FCS dropped
    assert struct.unpack_from("<BBHIHHb", raw, 40) == (0, 0, 13, 0x28, 5180, 0x0140, -40)
    assert CARD_NAME.match("CAP00012.SSC") and not CARD_NAME.match("../x")
    print("selftest: OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port (found automatically if one board is plugged in)")
    ap.add_argument("--out", help="folder to save into (default ./SignalSweep-<time>)")
    ap.add_argument("--wipe", action="store_true", help="delete card files that copied intact (asks first)")
    ap.add_argument("--phone", action="store_true", help="also copy the app's files off an Android phone")
    ap.add_argument("--no-board", action="store_true", help="with --phone: skip the board")
    ap.add_argument("--pcap", metavar="SSCAP", help="convert one capture file to .pcap and exit")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()
    if a.pcap:
        out = os.path.splitext(a.pcap)[0] + ".pcap"
        with open(a.pcap, encoding="utf-8", errors="replace") as f:
            print("%d Wi-Fi frames -> %s" % (sscap_to_pcap(f.read(), out), out))
        return

    # The port first: a busy port should not leave an empty folder behind.
    link = None if a.no_board else Link(a.port or pick_port())
    out = a.out or "SignalSweep-" + datetime.now().strftime("%Y%m%d-%H%M%S")
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    print("saving to " + os.path.abspath(out))

    if a.phone:
        pull_phone(out)
    if link is None:
        return
    time.sleep(0.5)

    recs, names, epochs = read_alert_log(link)
    write_reports(log_rows(recs, names, epochs), out, raw)
    print("  flash  alerts.txt + report.html  %d alert(s)" % len(recs))

    ls = card_list(link)
    if ls is None:
        die("the board did not answer. Is it running SignalSweep v0.7 or later?")
    if ls.get("state") != 1:
        print("  card   none / unreadable (state %s)" % ls.get("state"))
        return
    if ls.get("total", 0) > len(ls.get("files", [])):
        print("  card   note: the board lists only the newest %d of %d files" % (len(ls["files"]), ls["total"]))

    good = {}                                    # name -> size, copied and verified
    for f in ls.get("files", []):
        name, size = f["n"], f["s"]
        if not CARD_NAME.match(name):
            continue
        data, err = card_get(link, name, size)
        if err:
            print("  card   %-14s FAILED: %s" % (name, err))
            continue
        with open(os.path.join(raw, name), "wb") as fh:
            fh.write(data)
        good[name] = size
        extra = ""
        if name.endswith(".SSC"):
            pc = os.path.join(out, name[:-4] + ".pcap")
            extra = "  + %d Wi-Fi frames -> %s" % (sscap_to_pcap(data.decode("utf-8", "replace"), pc),
                                                  os.path.basename(pc))
        print("  card   %-14s %9d bytes  ok%s" % (name, size, extra))

    if a.wipe and good:
        if input("\nDelete the %d verified file(s) from the card? Type wipe: " % len(good)).strip() != "wipe":
            print("nothing deleted")
            return
        # Re-list first: a file that grew since it was copied (this boot's log
        # taking a new alert) would lose that alert. Leave it for next time.
        now = {f["n"]: f["s"] for f in (card_list(link) or {}).get("files", [])}
        for name, size in good.items():
            if now.get(name) != size:
                print("  wipe   %-14s kept (changed since it was copied)" % name)
                continue
            err = card_rm(link, name)
            print("  wipe   %-14s %s" % (name, "deleted" if not err else "FAILED: " + err))


if __name__ == "__main__":
    main()
