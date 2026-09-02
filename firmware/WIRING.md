# SignalSweep — Wiring Guide (XIAO ESP32-S3)

The pins below are the contract the firmware drives. They live in
`firmware/src/hardware_manager.h` — change the wiring only if you change those:

- **NeoPixel data → D1 / GPIO2** (`NEOPIXEL_PIN 2`, `NEOPIXEL_COUNT 8`)
- **Buzzer signal → D2 / GPIO3** (`BUZZER_PIN 3`)

Reading the board: Seeed silk-screens the pads **D0–D10**; the firmware names
the same pads by GPIO number (**D1 = GPIO2**, **D2 = GPIO3**). The pad printed
**VUSB** on the underside is the **5V** pad. Note the two sides: the D-pins
(D0–D6) are on one long edge, the power pads (5V/VUSB, GND, 3V3) on the other.

The buzzer is driven with `tone()` (a square wave at varying frequencies), so
use a **passive** buzzer/piezo. An active buzzer will still rhythm-out the
category patterns but ignores pitch (no rising/falling tones).

## Parts

| # | Part | Notes |
|---|------|-------|
| 1 | Seeed XIAO ESP32-S3 | The board the firmware targets |
| 1 | Passive buzzer / piezo | 2-pin (or a 3-pin module — see below) |
| 1 | WS2812/SK6812 8-LED bar (clone) | breaks out **VCC / IN / GND** (some clones have 4 pads — `GND, IN, VCC, GND`; the two GNDs are one net, use either). IN = DIN |
| — | Jumper wires | Dupont F-F if using headerless pads |
| opt | 330-470 Ω resistor | in series on the LED **data** line |
| opt | 1000 µF capacitor | across LED **5V ↔ GND** |

## Pin map

| XIAO pad | GPIO | Goes to |
|----------|------|---------|
| **D1** | GPIO2 | NeoPixel **DIN** |
| **D2** | GPIO3 | Buzzer **signal (+)** |
| **5V** | — | NeoPixel **VCC** (aka 5V) |
| **GND** | — | NeoPixel **GND** (either pad) *and* buzzer **(−)** (shared ground) |
| **3V3** | — | only a 3-pin active buzzer module's VCC |

## Steps

1. **Power the LED bar from 5V.** XIAO **5V pad → bar VCC/5V**, XIAO **GND →
   bar GND**. The 5V pad is USB bus power, which is what you run on.
2. **Data line.** XIAO **D1 (GPIO2) → bar IN** (the DIN / data-input pad).
   Watch the arrow silkscreen: wire the **input** end (`IN`, arrows pointing
   into the LEDs), not `OUT`. If you add the 330-470 Ω resistor, put it in
   series right at IN.
3. **Buzzer.** XIAO **D2 (GPIO3) → buzzer +**, XIAO **GND → buzzer −**. A small
   passive buzzer (<30 mA) drives fine straight off the GPIO.
   - *3-pin module instead?* VCC→3V3, GND→GND, I/O→D2 (GPIO3).
4. **Common ground.** Everything shares the XIAO GND pad. Two grounds (LED +
   buzzer) into the single GND pad is correct.
5. *(Recommended for the LED bar)* drop the **1000 µF cap** across the bar's 5V
   and GND to absorb the inrush when all 8 LEDs snap on during an alert flash.

## Power sanity

8× WS2812 at full white ≈ **480 mA**. SignalSweep only flashes the strip in
short colored bursts (never sustained full-white), so USB 5V handles it easily.
If you ever run it hard off a weak battery, that's the number to budget.

## Gotchas

- **3.3 V data into a 5 V-powered strip:** clones almost always accept it over
  the short run on a bar. If the first LED flickers or shows wrong colors,
  either add the series resistor, or power the bar from **3V3** instead (dimmer,
  but the data logic threshold then matches).
- **Wrong end of the bar** (wiring to DOUT) = nothing lights. Flip to DIN.
- **Active buzzer** = single fixed pitch; you'll hear the rhythm of each
  category pattern but not the tones. Passive is the intended part.

## Verify

1. `python flash.py --tier 1 --port COM3` (re-run after wiring).
2. On boot you should get a short jingle + an LED blink.
3. Trigger a match (an AirTag near it, or edit a signature) → the strip flashes
   a color and the buzzer plays that category's pattern:
   - ALPR / camera → two long beeps
   - body cam → long-short-short
   - drone → rising trill
   - tracker → fast ticking

## Diagram

```
                         Seeed XIAO ESP32-S3
                      ┌───────────────────────┐
                      │  [ USB-C ]             │
                      │                        │
                      │  D0/GPIO1          5V ●┼───────────┐   (5V bus)
        ┌─────────────┼● D1/GPIO2        GND ●┼────┐      │
        │             │  (NeoPixel DIN)  3V3 ●┼─┐  │      │
        │       ┌─────┼● D2/GPIO3             │ │  │      │
        │       │     │  (Buzzer signal)      │ │  │      │
        │       │     └───────────────────────┘ │  │      │
        │       │                          (3V3 only if    │
        │       │                           3-pin buzzer)  │
        │       │   PASSIVE BUZZER                         │
        │       │   ┌─────────┐                            │
        │       └──►│ +       │                            │
        │           │ (piezo) │                            │
        │        ┌──┤ −       │                            │
        │        │  └─────────┘                            │
        │        │        NeoPixel 8-LED bar (WS2812/SK6812 clone)
        │        │        ┌──────────────────────────────┐│
        │        │   5V ──┼● 5V/VCC ───────────────────────┘
        │        └───GND ─┼● GND ──────────────┐
        └──────DIN(GPIO2)─┼● DIN  ▷ ▷ ▷ ▷ DOUT │
                          │  [#][#][#][#][#][#][#][#]      │  ← arrows = data flow;
                          └──────────────────────────────┘     wire to the DIN end
                                    │
                                   GND → XIAO GND pad
                          (buzzer − and bar GND share it)
```

Optional hardening for the strip:

```
   XIAO D1 ──[ 330-470Ω ]──► DIN          + ──┤├── −   ← 1000µF cap
                                          across bar 5V ↔ GND
```
