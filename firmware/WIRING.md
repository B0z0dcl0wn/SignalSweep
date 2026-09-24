# SignalSweep — Wiring Guide (XIAO ESP32-C5 and ESP32-S3)

**All you need is the board.** A bare XIAO with its antenna is a working
detector: plug it into USB, connect the app, and it streams everything it
hears. Every other part is optional. Each one adds a capability, and the
firmware checks at boot for what is there. Leave a part off and you lose
exactly that feature, nothing else.

| Part | Required? | What it adds | Without it |
|------|-----------|--------------|------------|
| XIAO ESP32-S3 or ESP32-C5 + U.FL antenna | **Yes** | the detector | — |
| Passive buzzer | optional | the headless "what is near" beep patterns, and Hunt's beeps | phone only |
| WS2812 8-LED bar | optional | colour/animation per category, the hunt meter | phone only |
| DS3231 RTC module | optional | the alert log keeps real dates across power cuts, with no phone | the time comes from the phone at each connect and is lost when the power goes |
| microSD module | optional, **firmware support not shipped yet** | (coming) alert log and Site Survey captures on a card | — |
| C5 instead of S3 | optional | hears 5 GHz Wi-Fi too | 2.4 GHz only |

The pads are the contract. Wire by **pad name** (D1, D2, …) and the same
harness fits either board. Only the GPIO numbers underneath differ:

| XIAO pad | S3 GPIO | C5 GPIO | Goes to | Part |
|----------|---------|---------|---------|------|
| **D1** | GPIO2 | GPIO0 | LED bar **DIN** | LED bar |
| **D2** | GPIO3 | GPIO25 | buzzer **+** | buzzer |
| **D3** | GPIO4 | GPIO7 | SD **CS** | SD (reserved) |
| **D4** | GPIO5 | GPIO23 | RTC **SDA** | RTC |
| **D5** | GPIO6 | GPIO24 | RTC **SCL** | RTC |
| **D8** | GPIO7 | GPIO8 | SD **SCK** | SD (reserved) |
| **D9** | GPIO8 | GPIO9 | SD **MISO** | SD (reserved) |
| **D10** | GPIO9 | GPIO10 | SD **MOSI** | SD (reserved) |
| **5V** (VUSB) | — | — | LED bar **VCC** | power |
| **3V3** | — | — | RTC **VCC** (and a 3.3 V SD module) | power |
| **GND** | — | — | the ground chain (below) | power |
| BOOT button | GPIO0 | GPIO28 | tap = 2 min advertising window; hold 5 s = factory reset | built in |

Pin numbers come from `firmware/src/hardware_manager.h` (LED, buzzer) and the
board variant's `pins_arduino.h` (`SDA`/`SCL`, SPI). Change the wiring only if
you change those.

Reading the board: Seeed silk-screens the pads **D0–D10**. One long edge has
**D0–D6**; the other has **5V, GND, 3V3, D10, D9, D8, D7**. The pad printed
**VUSB** on the underside is the same 5V.

## One wire per XIAO pad: chain the power

The XIAO has one GND pad, one 3V3 and one 5V, each a tiny through-hole. With
every accessory fitted there are four grounds, which will not all fit in one
hole. So **each XIAO pad gets exactly one wire**. Power and ground then
**daisy-chain from part to part**, and any doubling up happens on the parts'
bigger pads and header pins, never on the XIAO.

It works because two of the parts already pass power through:

- **The LED bar**: a 4-pad clone has two GND pads (`GND, IN, VCC, GND`),
  which are one net. Ground comes in on one and leaves on the other. On a
  3-pad bar, its GND pad is big enough to take two wires.
- **The DS3231 module** (the common ZS-042 board): it has a header on
  **each end** (6-pin `32K SQW SCL SDA VCC GND` and 4-pin `SCL SDA VCC GND`),
  and the same-named pins are connected. Power and ground come in on one end
  and leave on the other.

Chain order (skip any part you don't have and join its neighbours):

```
GND : XIAO GND ─► LED bar GND ═► LED bar 2nd GND ─► RTC GND (4-pin end) ═► RTC GND (6-pin end) ─► SD GND
                       ▲
                       └── buzzer − (piggybacks on the bar's GND pad)

3V3 : XIAO 3V3 ─► RTC VCC (4-pin end) ═► RTC VCC (6-pin end) ─► SD VCC   (3.3 V SD module)

5V  : XIAO 5V  ─► LED bar VCC ─► SD VCC                                  (5 V SD module instead)

 ─►  a wire you add        ═►  already connected inside the part
```

**Which SD rail?** Check the label on your module's power pin. The common
"Micro SD Card Adapter" boards with a regulator and level shifter on them say
**VCC 5V**: chain them off the LED bar's VCC pad. Bare 3.3 V breakouts go on
the 3V3 chain after the RTC. Never feed 5 V to a bare 3.3 V card slot.

The signal wires are all one-to-one (pad → part) and never share a hole.

## Diagram

Every pad carries **one** wire. The labels say where it goes; the chain block
above says how power and ground continue from there. GPIOs are in the table
at the top.

```
                           Seeed XIAO ESP32-S3 / C5  (top view)
                          ┌────────────────────────────┐
                          │         [ USB-C ]          │
               (unused)   │ ● D0                  5V ● │ ──► LED bar VCC      (5V chain)
      LED bar DIN   ◄──── │ ● D1                 GND ● │ ──► LED bar GND      (GND chain)
      buzzer +      ◄──── │ ● D2                 3V3 ● │ ──► RTC VCC          (3V3 chain)
      SD CS         ◄ ─ ─ │ ● D3                 D10 ● │ ─ ─► SD MOSI
      RTC SDA       ◄──── │ ● D4                  D9 ● │ ─ ─► SD MISO
      RTC SCL       ◄──── │ ● D5                  D8 ● │ ─ ─► SD SCK
               (unused)   │ ● D6                  D7 ● │      (unused)
                          └────────────────────────────┘

      ────  driven by the firmware today       ─ ─  reserved for the SD card (not shipped yet)
```

What each part ends up with (skip any part you don't have):

```
  LED bar  (DIN end)            DS3231 (ZS-042)                    microSD module
  ┌──────────────────┐          ┌──────────────────────────────┐   ┌──────────────────┐
  │ VCC ◄ XIAO 5V    │          │ 4-pin end       6-pin end    │   │ VCC ◄ 3V3 chain  │
  │ GND ◄ XIAO GND   │          │ VCC ◄ XIAO 3V3  VCC ► SD VCC │   │       (or 5V)    │
  │ DIN ◄ D1         │          │ GND ◄ bar GND   GND ► SD GND │   │ GND ◄ RTC GND    │
  │ GND ► RTC GND    │          │ SDA ◄ D4        SDA  (spare) │   │ CS  ◄ D3         │
  │  └─ buzzer −     │          │ SCL ◄ D5        SCL  (spare) │   │ SCK ◄ D8         │
  └──────────────────┘          └──────────────────────────────┘   │ MISO► D9         │
                                                                    │ MOSI◄ D10        │
  Passive buzzer                                                    └──────────────────┘
  ┌──────────────────┐
  │ +  ◄ D2          │
  │ −  ► bar GND pad │
  └──────────────────┘
```

## Parts detail

- **Buzzer:** a **passive** buzzer/piezo, since it is driven with `tone()` at
  varying pitches. An active buzzer still plays each category's rhythm, but at
  one fixed pitch. For a 3-pin module: VCC → the 3V3 chain, GND → the GND
  chain, I/O → D2. A small passive buzzer (< 30 mA) drives fine straight off
  the GPIO.
- **LED bar:** WS2812/SK6812 8-LED clone. Wire the **DIN** end (the arrows
  point into the LEDs), not DOUT. Optional hardening: a 330–470 Ω resistor in
  series at DIN, and a 1000 µF cap across the bar's VCC ↔ GND to absorb the
  inrush when all eight LEDs snap on.
- **DS3231:** any breakout at I²C address 0x68 works. The ZS-042 board already
  has pull-up resistors on SDA/SCL, so add none. It keeps time on its coin
  cell while the board is unpowered. The app sets the clock on every connect,
  and if the cell dies, the next connect fixes it.
- **C5 antenna:** use a **dual-band** U.FL antenna. The stock one is 2.4 GHz only.

## Power sanity

8× WS2812 at full white ≈ **480 mA**. SignalSweep only flashes the bar in
short coloured bursts (never sustained full white), so USB 5V handles it
easily. The DS3231 and an SD module add a few mA idle, and roughly 100 mA
peaks on SD writes. If you run it off a weak battery, budget for those numbers.

## Gotchas

- **ZS-042 + a CR2032:** that board has a trickle-charge circuit (a resistor
  and diode near the header) meant for a rechargeable LIR2032. Fed from 3V3 —
  which is how this guide wires it — the charge voltage through the diode
  (~2.7 V) is below a CR2032's own 3.0 V, so no charge current flows: a plain
  CR2032 here is harmless. The hazard is feeding the module **5 V** with a
  plain CR2032 fitted — that does charge it, which it is not built for. If you
  must run the module at 5 V, fit an LIR2032, or remove the diode or resistor.
- **3.3 V data into a 5 V-powered LED bar:** clones almost always accept it
  over the short run on a bar. If the first LED flickers or shows the wrong
  colours, add the series resistor, or power the bar from 3V3 (dimmer, but the
  data logic threshold then matches).
- **Wrong end of the bar** (wired to DOUT) = nothing lights. Flip to DIN.
- **Two wires in one XIAO pad** is how a joint cracks. Chain instead (above).

## Verify

1. Install with the web flasher, or `python flash.py --tier 1 --port COMx`.
2. On boot: a short jingle and an LED blink (if fitted). The serial log says
   `[RTC] DS3231 ok, clock set`, `[RTC] DS3231 lost power, waiting for a host`,
   or `[RTC] none fitted, waiting for a host`.
3. Connect the app. **Settings › Device identity › Clock** shows whether an
   RTC was found and that the phone synced it.
4. Trigger a match (an AirTag near it, or edit a signature). The bar flashes
   and the buzzer plays that category's pattern:
   - ALPR / camera → two long beeps
   - body cam → long-short-short
   - drone → rising trill
   - tracker → fast ticking
