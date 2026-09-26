# SignalSweep — Wiring Guide (XIAO ESP32-C5 and ESP32-S3)

**All you need is the board.** A bare XIAO with its antenna is a working
detector: plug it into USB, connect the app, and it streams everything it
hears. Every other part is optional. Leave a part off and you lose exactly
that feature, nothing else.

Illustrated versions: [`wiring-diagram.html`](wiring-diagram.html) (S3) and
[`wiring-diagram-c5.html`](wiring-diagram-c5.html) (C5).

| Part | Required? | What it adds | Without it |
|------|-----------|--------------|------------|
| XIAO ESP32-S3 or ESP32-C5 + U.FL antenna (C5: dual-band) | **Yes** | the detector | — |
| Passive buzzer | optional | the headless "what is near" beep patterns, and Hunt's beeps | phone only |
| WS2812 8-LED bar | optional | colour/animation per category, the hunt meter | phone only |
| microSD reader (3.3 V, 6 pins, no regulator) | optional, **firmware support coming** | (coming) alert log and Site Survey captures on a card | — |
| DS3231 clock module | optional, **not fitted on this build** | real dates across power cuts with no phone | the phone or PC sets the time at each connect |
| C5 instead of S3 | optional | hears 5 GHz Wi-Fi too | 2.4 GHz only |

The pads are the contract. Wire by **pad name** (D1, D2, …) and the same
harness fits either board. Only the GPIO numbers underneath differ. The SD
reader's pins are named as printed on the module (`CLK` is the SPI clock):

| XIAO pad | S3 GPIO | C5 GPIO | Goes to | Part |
|----------|---------|---------|---------|------|
| **D1** | GPIO2 | GPIO0 | LED bar **DIN** | LED bar |
| **D2** | GPIO3 | GPIO25 | buzzer **+** | buzzer |
| **D3** | GPIO4 | GPIO7 | SD **CS** (chip select) | SD reader |
| **D4** | GPIO5 | GPIO23 | nothing: reserved for the clock (SDA) | not fitted |
| **D5** | GPIO6 | GPIO24 | nothing: reserved for the clock (SCL) | not fitted |
| **D8** | GPIO7 | GPIO8 | SD **CLK** (SPI clock) | SD reader |
| **D9** | GPIO8 | GPIO9 | from SD **MISO** (data into the XIAO) | SD reader |
| **D10** | GPIO9 | GPIO10 | SD **MOSI** | SD reader |
| **5V** (VUSB) | — | — | LED bar **VCC** | power |
| **3V3** | — | — | SD **3v3**, the only 3V3 load | power |
| **GND** | — | — | LED bar **GND** pad 1 (ground continues from the bar) | power |
| BOOT button | GPIO0 | GPIO28 | tap = 2 min advertising window; hold 5 s = factory reset | built in |

Pin numbers come from `firmware/src/hardware_manager.h` (LED, buzzer) and the
board variant's `pins_arduino.h` (`SDA`/`SCL`, SPI). Change the wiring only if
you change those.

Reading the board: Seeed silk-screens the pads **D0–D10**. One long edge has
**D0–D6**; the other has **5V, GND, 3V3, D10, D9, D8, D7**, with USB-C at the
top. The pad printed **VUSB** on the underside is the same 5V.

## The microSD reader: 3.3 V ONLY

The reader drawn here is a small blue board with a bare microSD slot and **no
regulator**: 6 pins in a row, silkscreen top to bottom
`3v3, CS, MOSI, CLK, MISO, GND`.

> **Never connect this board to 5V.** It has no regulator, and 5V can kill
> the card. Its `3v3` pin goes to the XIAO's **3V3** pad and nothing else.

The wiring is final, but the firmware does not drive the card yet (support is
coming). Other SD readers order their pins differently, and some are 5V
modules with a regulator; with any other reader, match by label and check its
power pin's marking.

## One wire per XIAO pad

The XIAO's holes are tiny, and two wires shoved into one is how a joint
cracks. So **each XIAO pad gets exactly one wire**. Where two wires have to
meet (ground), they meet on the LED bar's bigger pads, never on the XIAO.

It works because the common 4-pad bar (`GND, IN, VCC, GND`) has two GND pads
that are one net on the bar, each big enough for two wires:

```
GND : XIAO GND ─► bar GND pad 1 ═► bar GND pad 2 ─► SD GND
                       ▲
                       └── buzzer − (shares pad 1 with the wire from the XIAO)

3V3 : XIAO 3V3 ─► SD 3v3          (one wire: the SD reader is the only 3V3 load)

5V  : XIAO 5V  ─► LED bar VCC     (one wire: nothing on the SD reader goes to 5V)

 ─►  a wire you add        ═►  already connected inside the part
```

A 3-pad bar has one GND pad, which would need all three ground wires. No bar
at all? Splice the buzzer − and SD GND wires together (solder + heat-shrink)
and run one wire from the splice to the XIAO GND pad.

## Diagram

```
                           Seeed XIAO ESP32-S3 / C5  (top view)
                          ┌────────────────────────────┐
                          │         [ USB-C ]          │
               (unused)   │ ○ D0                  5V ● │ ──► LED bar VCC
      LED bar DIN   ◄──── │ ● D1                 GND ● │ ──► LED bar GND pad 1
      buzzer +      ◄──── │ ● D2                 3V3 ● │ ──► SD 3v3 (3.3 V only)
      SD CS         ◄──── │ ● D3                 D10 ● │ ──► SD MOSI
      reserved: clock     │ ○ D4                  D9 ● │ ◄── SD MISO
      reserved: clock     │ ○ D5                  D8 ● │ ──► SD CLK
               (unused)   │ ○ D6                  D7 ○ │      (unused)
                          └────────────────────────────┘
```

What each part ends up with (skip any part you don't have):

```
  LED bar  (IN end)              microSD reader (pins top to bottom)
  ┌──────────────────────────┐   ┌──────────────────────────────┐
  │ GND ◄ XIAO GND           │   │ 3v3  ◄ XIAO 3V3  (never 5V)  │
  │  └─ buzzer −             │   │ CS   ◄ D3                    │
  │ IN  ◄ D1                 │   │ MOSI ◄ D10                   │
  │ VCC ◄ XIAO 5V            │   │ CLK  ◄ D8                    │
  │ GND ► SD GND             │   │ MISO ► D9                    │
  └──────────────────────────┘   │ GND  ◄ bar GND pad 2         │
                                 └──────────────────────────────┘
  Passive buzzer
  ┌──────────────────────────┐
  │ +  ◄ D2                  │
  │ −  ► bar GND pad 1       │
  └──────────────────────────┘
```

## Assembly order

1. **Antenna.** Press the U.FL antenna onto the XIAO's socket until it clicks
   (C5: use a dual-band one).
2. **LED bar.** Bar `VCC` → XIAO `5V`; bar GND pad 1 (beside IN) → XIAO
   `GND`; bar `IN` → XIAO `D1`.
3. **Buzzer.** Buzzer `+` → XIAO `D2`; buzzer `−` → bar GND pad 1.
4. **SD reader power (3.3 V only).** SD `3v3` → XIAO `3V3`; SD `GND` → bar
   GND pad 2 (beside VCC).
5. **SD reader data.** SD `CS` → `D3`, `MOSI` → `D10`, `CLK` → `D8`,
   `MISO` → `D9`.
6. **Check before power:** nothing on the SD reader touches 5V, one wire per
   XIAO pad, no strands bridging two pads, D4/D5 empty.
7. **Verify** (below).

## Optional clock (DS3231): parked

Not fitted on this build. The phone or PC sets the time on every connect,
which dates the alert log, so the clock only matters for real dates across
power cuts with no phone. **D4 (SDA) / D5 (SCL) are reserved for it**; leave
them empty.

If you fit one later: any DS3231 breakout at I²C address 0x68. `VCC` → 3V3,
`SDA` → D4, `SCL` → D5, `GND` → ground. The small "DS3231 For Pi" module
labels these `+ D C NC −` (`NC` gets no wire); a ZS-042 uses the plain names.
Two catches: 3V3 already has the SD reader on it, so the clock's power needs a
splice rather than a second wire in the XIAO 3V3 hole; and "For Pi" boards
often omit the I²C pull-ups (add 4.7 kΩ from D4 and from D5 to 3V3 if the
serial log says `[RTC] none fitted` with it attached).

## Parts detail

- **Buzzer:** a **passive** buzzer/piezo, since it is driven with `tone()` at
  varying pitches. An active buzzer still plays each category's rhythm, but at
  one fixed pitch. A small passive buzzer (< 30 mA) drives fine straight off
  the GPIO.
- **LED bar:** WS2812/SK6812 8-LED clone. Wire the **DIN** end (the arrows
  point into the LEDs), not DOUT. Optional hardening: a 330–470 Ω resistor in
  series at DIN, and a 1000 µF cap across the bar's VCC ↔ GND to absorb the
  inrush when all eight LEDs snap on.
- **microSD reader:** see above. 3.3 V only.
- **C5 antenna:** use a **dual-band** U.FL antenna. The stock one is 2.4 GHz only.

## Power sanity

8× WS2812 at full white ≈ **480 mA**. SignalSweep only flashes the bar in
short coloured bursts (never sustained full white), so USB 5V handles it
easily. An SD card adds a few mA idle and roughly 100 mA peaks on writes, all
from the XIAO's 3V3. If you run it off a weak battery, budget for those.

## Gotchas

- **SD reader on 5V** kills the card. This one has no regulator: 3V3 only.
- **3.3 V data into a 5 V-powered LED bar:** clones almost always accept it
  over the short run on a bar. If the first LED flickers or shows the wrong
  colours, add the series resistor at DIN.
- **Wrong end of the bar** (wired to DOUT) = nothing lights. Flip to DIN.
- **Two wires in one XIAO pad** is how a joint cracks. Double up on a bar pad.
- **C5 and D3 (GPIO7):** GPIO7 may be sampled at boot, and nobody has booted a
  C5 with the SD reader wired yet. If the C5 won't start with the SD reader
  connected, unplug the CS wire (D3), power up, and tell us.

## Verify

1. Install with the web flasher, or `python flash.py --tier 1 --port COMx`.
2. On boot: a short jingle and an LED blink (if fitted). With no clock fitted
   the serial log says `[RTC] none fitted, waiting for a host`, which is
   expected.
3. Connect the app. **Settings › Device identity › Clock** shows the phone
   synced the time.
4. Trigger a match (an AirTag near it, or edit a signature). The bar flashes
   and the buzzer plays that category's pattern:
   - ALPR / camera → two long beeps
   - body cam → long-short-short
   - drone → rising trill
   - tracker → fast ticking
