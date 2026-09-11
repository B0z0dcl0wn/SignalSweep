// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 B0z0dcl0wn and the SignalSweep contributors

#include "hardware_manager.h"
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

static const char *TAG = "HardwareManager";

// The buzzer mute is operator state on a headless device, so it lives in NVS
// like the hunt target and the beep mask. It was read here at boot and never
// written, which meant a board muted in the field came back beeping.
// The LED mode lives here too (key "led"): this namespace is the output prefs,
// and a new one would be one more thing a rename could orphan.
#define BUZZER_NVS_NS "sweep-bz"

#define LED_FULL_BRIGHTNESS 50
// ponytail: 8/255 is a guess for the bench bars; raise it if Dim reads as off.
#define LED_DIM_BRIGHTNESS  8

static Adafruit_NeoPixel strip(NEOPIXEL_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
static SemaphoreHandle_t hwMutex = NULL;
static TaskHandle_t hwTaskHandle = NULL;

static OperatingMode currentHwMode = MODE_SELECTOR;
// Read and written WITHOUT hwMutex, deliberately. It is a single bool, so a
// torn read is impossible on this core; the mutex exists to protect buzzerOff()
// and the tone state, not this flag. Taking it here was actively harmful: both
// accessors gave up after 50 ms, and the audio task takes hwMutex every loop.
// A timed-out isBuzzerEnabled() returned `true` -- so a muted board reported
// itself audible to CMD:CFG and to the 1 Hz push -- and a timed-out
// setBuzzerEnabled() skipped the RAM write while the NVS write below still
// landed, leaving a board that beeps now and boots silent later.
static volatile bool buzzerEnabled = true;
// Same contract as buzzerEnabled: one byte, read by the render loop and written
// by the command handler without hwMutex, so changing it can never fail on a lock.
static volatile uint8_t ledMode = LED_FULL;
static bool rxOnlyIndicator = false;

// Arduino's tone() attaches the LEDC channel lazily on first use, and noTone()
// on a channel that was never attached logs an error every single call. Nothing
// hit this while a board always booted audible -- tone() ran first. Now that the
// mute persists, a board that boots muted never calls tone() at all, and the
// unguarded noTone()s in the audio loop flooded the USB telemetry mirror.
// Measured on COM3: 561 LEDC errors in 4 s booted muted, 0 booted audible.
static volatile bool ledcReady = false;
// ledcReady is set AFTER tone() returns: setting it first left a window in
// which setBuzzerEnabled() on the caller's thread could noTone() a channel
// tone() had not finished attaching -- one stray error per mute transition.
static inline void buzzerTone(uint16_t freq) { tone(BUZZER_PIN, freq); ledcReady = true; }
static inline void buzzerOff() { if (ledcReady) noTone(BUZZER_PIN); }

struct Note {
    uint16_t freq;       // Hz (0 = rest/silence)
    uint16_t durationMs; // Duration in ms
};

static Note activeJingle[8];
static uint8_t jingleLength = 0;
static uint8_t jingleIndex = 0;
static uint32_t noteStartTime = 0;
static bool jinglePlaying = false;

static bool geigerLocked = false;
static int geigerRssi = -90;
static bool geigerTriggerImmediate = false;
static uint32_t lastGeigerClickTime = 0;
static bool geigerClickActive = false;
static uint32_t geigerClickStartTime = 0;

static bool flashActive = false;
static uint8_t flashR = 0, flashG = 0, flashB = 0;
static uint32_t flashEndTime = 0;

static bool alarmActive = false;
static uint32_t alarmEndTime = 0;

// A category alert plays a short animation across the whole bar. Like the
// buzzer pattern it is the ID: a different shape per category, so it reads
// across a room and with the buzzer muted. Indexed by AlertCategory; ANIM_BOOT
// is the power-on sweep. Durations outlast the jingle a little on purpose.
#define ANIM_BOOT 5
static const uint16_t ANIM_MS[] = {1600, 900, 1380, 1300, 900, 1200};
static int8_t animCat = -1;  // -1 = none
static uint32_t animStart = 0;

static uint32_t dim(uint32_t c, float k) {
    if (k <= 0) return 0;
    if (k > 1) k = 1;
    return strip.Color(((c >> 16) & 0xFF) * k, ((c >> 8) & 0xFF) * k, (c & 0xFF) * k);
}

// Brightness at distance d from a bright point, reaching 0 at w. Squared so
// tails look soft rather than stepped.
static float falloff(float d, float w) {
    float k = 1 - d / w;
    return k > 0 ? k * k : 0;
}

static void drawAnimation(int cat, uint32_t e) {
    const int N = NEOPIXEL_COUNT;
    const float mid = (N - 1) / 2.0f;
    switch (cat) {
        case ALERT_ALPR: {  // plate-reader sweep: a red comet bounces end to end, twice
            float ph = (e % 800) / 400.0f;
            float x = (ph < 1 ? ph : 2 - ph) * (N - 1);
            for (int i = 0; i < N; i++)
                strip.setPixelColor(i, dim(strip.Color(255, 0, 0), falloff(fabsf(i - x), 2.5f)));
            break;
        }
        case ALERT_BODYCAM: {  // camera flash: three pops (long-short-short) burst
                               // from the centre white-hot, then cool to amber
            static const uint16_t pops[] = {0, 340, 500};  // the jingle's note starts
            uint32_t t = e;
            for (uint16_t p : pops) if (e >= p) t = e - p;
            for (int i = 0; i < N; i++) {
                if (fabsf(i - mid) > t / 30.0f + 0.5f) continue;  // burst grows 1 px / 30 ms
                strip.setPixelColor(i, t < 50 ? strip.Color(255, 255, 255)
                                              : dim(strip.Color(255, 70, 0), 1 - t / 320.0f));
            }
            break;
        }
        case ALERT_DRONE: {  // rising trill: the bar fills upward, then two rotor
                             // blades chase round it and wind down
            if (e < 480) {
                for (int i = 0; i <= (int)(e / 60) && i < N; i++)
                    strip.setPixelColor(i, strip.Color(0, 200 - i * 20, 255));
            } else {
                uint32_t t = e - 480;
                float fade = 1 - t / 900.0f;
                int k = (t / 45) % N;
                for (int i = 0; i < N; i++) {
                    bool blade = i == k || i == (k + N / 2) % N;
                    strip.setPixelColor(i, blade ? dim(strip.Color(200, 230, 255), fade)
                                                 : dim(strip.Color(0, 60, 255), fade * 0.5f));
                }
            }
            break;
        }
        case ALERT_TRACKER: {  // four ticks on alternating pixels, then two sonar
                               // pings ripple out from the centre
            if (e < 400) {
                if (e % 100 < 45)
                    for (int i = (e / 100) % 2; i < N; i += 2)
                        strip.setPixelColor(i, strip.Color(255, 0, 200));
            } else {
                uint32_t t = e - 400;
                float wave = (t % 450) / 450.0f * (mid + 1);
                float fade = 1 - t / 900.0f;
                for (int i = 0; i < N; i++)
                    strip.setPixelColor(i, dim(strip.Color(255, 0, 200),
                                               falloff(fabsf(fabsf(i - mid) - wave), 1.2f) * fade));
            }
            break;
        }
        case ANIM_BOOT: {  // rainbow wipes on, then fades
            float fade = e < 700 ? 1 : 1 - (e - 700) / 500.0f;
            for (int i = 0; i < N && e >= (uint32_t)i * 70; i++)
                strip.setPixelColor(i, dim(strip.gamma32(strip.ColorHSV((uint16_t)(i * 65536 / N + e * 40))), fade));
            break;
        }
        default: {  // matched, category unknown: one amber breath
            float k = e < 450 ? e / 450.0f : 1 - (e - 450) / 450.0f;
            strip.fill(dim(strip.Color(255, 165, 0), k));
            break;
        }
    }
}

// Hunting: the bar is a steady signal meter, one pixel per ~8 dB (-95 dBm = 1
// lit, -30 = all 8), on the same scale as the Geiger clicker. Read like a
// phone's signal bars: the count is the strength and the whole meter is one
// colour -- red below ~-71 dBm, yellow to ~-50, green above (roughly within a
// metre of a BLE tag). Colouring by position (green first, red last, a heat
// gauge) painted a weak -76 dBm as four green bars, which reads as "good
// signal". Steady on purpose: it used to flare
// on every Geiger click, which at 2-3 clicks/s was hard to look at, and the ear
// already has the clicks. RSSI jumps several dB between adverts, so the level
// is smoothed (~1 s) and the top pixel lit in proportion -- the bar glides
// instead of hopping a whole LED on every packet.
static void drawHuntMeter(int rssi) {
    static float level = -1;
    float target = (rssi + 95) * NEOPIXEL_COUNT / 65.0f + 1;
    level = level < 0 ? target : level + (target - level) * 0.02f;  // per 15 ms tick
    float fill = constrain(level, 1.0f, (float)NEOPIXEL_COUNT);
    uint32_t c = fill < 4 ? strip.Color(255, 0, 0) : fill < 6.5f ? strip.Color(255, 180, 0) : strip.Color(0, 255, 0);
    for (int i = 0; i < NEOPIXEL_COUNT; i++)
        strip.setPixelColor(i, dim(c, 0.5f * constrain(fill - i, 0.0f, 1.0f)));
}

// Calculate Geiger click pitch and repetition interval from RSSI (-95 to -30 dBm)
static inline void calculateGeigerParams(int rssi, uint16_t &freqOut, uint32_t &intervalOut) {
    int clampedRssi = rssi;
    if (clampedRssi < -95) clampedRssi = -95;
    if (clampedRssi > -30) clampedRssi = -30;

    float t = (float)(clampedRssi - (-95)) / (float)(-30 - (-95)); // 0.0 (weak) to 1.0 (strong)
    freqOut = 500 + (uint16_t)(t * 2000.0f);     // 500 Hz to 2500 Hz
    intervalOut = 1000 - (uint32_t)(t * 920.0f); // 1000 ms down to 80 ms
}

static void loadJingleNotes(OperatingMode mode) {
    jingleIndex = 0;
    noteStartTime = 0;

    switch (mode) {
        case MODE_SELECTOR:
            activeJingle[0] = {523, 80};  // C5
            activeJingle[1] = {659, 80};  // E5
            activeJingle[2] = {784, 120}; // G5
            jingleLength = 3;
            break;
        case MODE_BEACON_BANDIT:
            activeJingle[0] = {880, 60};   // A5
            activeJingle[1] = {1175, 60};  // D6
            activeJingle[2] = {1760, 120}; // A6
            jingleLength = 3;
            break;
        case MODE_WATCHERS_WATCH:
            activeJingle[0] = {600, 70};
            activeJingle[1] = {900, 70};
            activeJingle[2] = {1200, 120};
            jingleLength = 3;
            break;
        case MODE_SKY_SWEEPER:
            activeJingle[0] = {1000, 50};
            activeJingle[1] = {1400, 50};
            activeJingle[2] = {1800, 50};
            activeJingle[3] = {2400, 100};
            jingleLength = 4;
            break;
        case MODE_SHADOW:
            // Descending, watchful — you're the one being followed.
            activeJingle[0] = {1200, 70};
            activeJingle[1] = {900, 70};
            activeJingle[2] = {600, 140};
            jingleLength = 3;
            break;
        default:
            jingleLength = 0;
            break;
    }
    jinglePlaying = (jingleLength > 0);
}

static void HardwareManagerTask(void *pvParameters) {
    (void)pvParameters;
    static uint8_t lastFrame[NEOPIXEL_COUNT * 3];

    for (;;) {
        if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            uint32_t now = millis();

            // 1. Process Jingle Audio
            if (jinglePlaying) {
                if (noteStartTime == 0) {
                    noteStartTime = now;
                    if (activeJingle[jingleIndex].freq > 0 && buzzerEnabled) {
                        buzzerTone(activeJingle[jingleIndex].freq);
                    } else {
                        buzzerOff();
                    }
                } else if (now - noteStartTime >= activeJingle[jingleIndex].durationMs) {
                    buzzerOff();
                    jingleIndex++;
                    if (jingleIndex < jingleLength) {
                        noteStartTime = now;
                        if (activeJingle[jingleIndex].freq > 0 && buzzerEnabled) {
                            buzzerTone(activeJingle[jingleIndex].freq);
                        }
                    } else {
                        jinglePlaying = false;
                        jingleIndex = 0;
                        jingleLength = 0;
                        buzzerOff();
                    }
                }
            }

            // 2. Process Geiger Counter Audio (when no jingle is active)
            if (!jinglePlaying) {
                if (geigerClickActive) {
                    if (now - geigerClickStartTime >= 25) { // 25ms Geiger click duration
                        buzzerOff();
                        geigerClickActive = false;
                    }
                }

                if (geigerLocked) {
                    uint16_t gFreq;
                    uint32_t gInterval;
                    calculateGeigerParams(geigerRssi, gFreq, gInterval);

                    if (geigerTriggerImmediate || (now - lastGeigerClickTime >= gInterval)) {
                        geigerTriggerImmediate = false;
                        geigerClickActive = true;
                        geigerClickStartTime = now;
                        lastGeigerClickTime = now;

                        if (buzzerEnabled) {
                            buzzerTone(gFreq);
                        }
                        // The visual click is the hunt meter's flare (drawHuntMeter).
                    }
                } else if (!geigerClickActive && !alarmActive) {
                    buzzerOff();
                }
            }

            // 2.5 Process Alarm Audio (overrides Geiger)
            if (alarmActive) {
                if (now < alarmEndTime) {
                    if (buzzerEnabled) {
                        uint32_t t = now % 300;
                        buzzerTone(t < 150 ? 2500 : 1800); // Police siren style
                    }
                    
                    // Strobe red/blue
                    flashActive = true;
                    uint32_t ft = now % 200;
                    if (ft < 100) {
                        flashR = 255; flashG = 0; flashB = 0;
                    } else {
                        flashR = 0; flashG = 0; flashB = 255;
                    }
                    flashEndTime = now + 10; 
                } else {
                    alarmActive = false;
                    buzzerOff();
                }
            }

            // 3. Render the bar. Priority: a hard flash (siren strobe, manual
            // triggerLedFlash) > a category alert animation > the hunt meter >
            // the idle heartbeat. The frame is redrawn every tick and pushed to
            // the strip only when it changed.
            uint32_t currentPixelColor = strip.Color(0, 0, 0);
            bool onePixel = false;  // idle heartbeat lights LED 0 only
            bool drawn = false;     // an animation or the meter owns the frame
            // No-op when unchanged. Its rescale of the stored pixels is lossy,
            // which doesn't matter: the frame is rebuilt from scratch below.
            strip.setBrightness(ledMode == LED_DIM ? LED_DIM_BRIGHTNESS : LED_FULL_BRIGHTNESS);
            strip.clear();

            if (flashActive && now >= flashEndTime) flashActive = false;
            if (flashActive) {
                currentPixelColor = strip.Color(flashR, flashG, flashB);
            } else if (animCat >= 0 && now - animStart < ANIM_MS[animCat]) {
                drawAnimation(animCat, now - animStart);
                drawn = true;
            } else if (geigerLocked) {
                animCat = -1;
                drawHuntMeter(geigerRssi);
                drawn = true;
            } else {
                animCat = -1;
                switch (currentHwMode) {
                    case MODE_SELECTOR: {
                        uint32_t t = now % 1000;
                        if (t < 200) currentPixelColor = strip.Color(0, 200, 255); // Cyan blink
                        break;
                    }
                    case MODE_BEACON_BANDIT: {
                        uint32_t t = now % 1200;
                        if (geigerLocked) {
                            if (t < 300) currentPixelColor = strip.Color(255, 0, 128); // Magenta lock pulse
                        } else {
                            if (t < 100 || (t >= 220 && t < 320)) {
                                currentPixelColor = strip.Color(255, 165, 0); // Amber double blink
                            }
                        }
                        break;
                    }
                    case MODE_WATCHERS_WATCH: {
                        // Idle heartbeat: one dim pixel glows up and down once
                        // every 4 s. Enough to tell alive from unpowered, not
                        // enough to notice across a room or through a car
                        // window — the whole bar blinking every 0.8 s was a
                        // beacon. Full-bar colour is reserved for alerts.
                        // Receive-only is invisible by definition, and a device
                        // that looks broken is worse than one that is. Blue
                        // instead of green says "still watching, not talking".
                        uint32_t t = now % 4000;
                        if (t < 800) {
                            uint32_t s = t < 400 ? t : 800 - t;  // 0..400..0
                            currentPixelColor = rxOnlyIndicator
                                ? strip.Color(0, 40 * s / 400, 110 * s / 400)
                                : strip.Color(0, 120 * s / 400, 50 * s / 400);
                            onePixel = true;
                        }
                        break;
                    }
                    case MODE_SKY_SWEEPER: {
                        uint32_t t = now % 600;
                        if (t < 80) currentPixelColor = strip.Color(120, 0, 255); // Violet strobe
                        break;
                    }
                    case MODE_SHADOW: {
                        uint32_t t = now % 2000;
                        // Slow white "sweep" breath — passive, patient watching
                        if (t < 500) {
                            uint8_t v = (uint8_t)((t * 180) / 500);
                            currentPixelColor = strip.Color(v, v, v);
                        } else if (t < 1000) {
                            uint8_t v = (uint8_t)(180 - (((t - 500) * 180) / 500));
                            currentPixelColor = strip.Color(v, v, v);
                        }
                        break;
                    }
                }
            }

            if (!drawn) {
                if (onePixel) strip.setPixelColor(0, currentPixelColor);
                else strip.fill(currentPixelColor);
            }
            // LED mode, applied to the finished frame so nothing above needs
            // to know about it. Off means off -- boot sweep and the BOOT-hold
            // flash included. One LED keeps the frame's brightest colour on
            // pixel 0, so the hunt meter still reads red/yellow/green and an
            // alert still shows its category colour.
            if (ledMode == LED_OFF) {
                strip.clear();
            } else if (ledMode == LED_ONE) {
                uint8_t *px = strip.getPixels();
                int best = 0, bestSum = -1;
                for (int i = 0; i < NEOPIXEL_COUNT; i++) {
                    int s = px[i * 3] + px[i * 3 + 1] + px[i * 3 + 2];
                    if (s > bestSum) { bestSum = s; best = i; }
                }
                memmove(px, px + best * 3, 3);
                memset(px + 3, 0, (NEOPIXEL_COUNT - 1) * 3);
            }
            if (memcmp(lastFrame, strip.getPixels(), sizeof(lastFrame)) != 0) {
                memcpy(lastFrame, strip.getPixels(), sizeof(lastFrame));
                strip.show();
            }

            xSemaphoreGive(hwMutex);
        }

        vTaskDelay(pdMS_TO_TICKS(15));
    }
}

void hardwareInit() {
    if (hwMutex == NULL) {
        hwMutex = xSemaphoreCreateMutex();
    }

    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);

    strip.begin();
    strip.setBrightness(50);
    strip.show();  // blank; the task plays the boot sweep
    animCat = ANIM_BOOT;
    animStart = millis();

    Preferences prefs;
    if (prefs.begin(BUZZER_NVS_NS, true)) {
        buzzerEnabled = prefs.getBool("on", true);
        uint8_t led = prefs.getUChar("led", LED_FULL);
        ledMode = led > LED_FULL ? LED_FULL : led;
        prefs.end();
    } else {
        buzzerEnabled = true;
    }
    ESP_LOGI(TAG, "Hardware Manager initialized. Buzzer %s", buzzerEnabled ? "ENABLED" : "MUTED");

    xTaskCreatePinnedToCore(
        HardwareManagerTask,
        "HardwareTask",
        3072,
        NULL,
        2,
        &hwTaskHandle,
        1
    );
}

void hardwareSetMode(OperatingMode mode) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        currentHwMode = mode;
        loadJingleNotes(mode);
        if (mode != MODE_BEACON_BANDIT) {
            geigerLocked = false;
        }
        xSemaphoreGive(hwMutex);
        ESP_LOGI(TAG, "Hardware mode updated to: %s", getModeName(mode));
    }
}

void playModeJingle(OperatingMode mode) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        loadJingleNotes(mode);
        xSemaphoreGive(hwMutex);
    }
}

void playConnectionChirp() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        jingleIndex = 0;
        noteStartTime = 0;
        activeJingle[0] = {1500, 100};
        activeJingle[1] = {2500, 150};
        jingleLength = 2;
        jinglePlaying = true;
        xSemaphoreGive(hwMutex);
    }
}

void playDisconnectionChirp() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        jingleIndex = 0;
        noteStartTime = 0;
        activeJingle[0] = {2500, 150};
        activeJingle[1] = {1500, 100};
        jingleLength = 2;
        jinglePlaying = true;
        xSemaphoreGive(hwMutex);
    }
}

void setRxOnlyIndicator(bool quiet) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        rxOnlyIndicator = quiet;
        xSemaphoreGive(hwMutex);
    }
}

void updateGeigerRssi(int rssi) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        geigerLocked = true;
        geigerRssi = rssi;
        xSemaphoreGive(hwMutex);
    }
}

void setGeigerTargetLock(bool locked, int initialRssi) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        geigerLocked = locked;
        if (locked) {
            geigerRssi = initialRssi;
        } else {
            buzzerOff();
        }
        xSemaphoreGive(hwMutex);
        ESP_LOGI(TAG, "Geiger target lock state: %s (RSSI: %d)", locked ? "LOCKED" : "UNLOCKED", initialRssi);
    }
}

void setBuzzerEnabled(bool enabled) {
    // The flag first and outside the mutex, so the setting takes effect even if
    // the audio task is holding hwMutex right now. Silencing a buzzer must not
    // be able to fail on a lock.
    buzzerEnabled = enabled;
    ESP_LOGI(TAG, "Buzzer set to: %s", enabled ? "ENABLED" : "MUTED");
    // Only the tone hardware needs the mutex. Missing this window costs at most
    // the tail of one in-flight beep -- the flag above already stops the next.
    if (!enabled && hwMutex != NULL &&
        xSemaphoreTake(hwMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        buzzerOff();
        xSemaphoreGive(hwMutex);
    }
    // Outside the mutex deliberately: an NVS write is slow and must not be held
    // against the audio task, which takes hwMutex every loop.
    Preferences prefs;
    if (prefs.begin(BUZZER_NVS_NS, false)) {
        prefs.putBool("on", enabled);
        prefs.end();
    } else {
        ESP_LOGW(TAG, "Could not open %s — mute will not survive a reboot", BUZZER_NVS_NS);
    }
}

bool isBuzzerEnabled() {
    // No mutex: see the declaration. This is reported by CMD:CFG and by the
    // 1 Hz push, and the app now paints its sound controls from it, so it must
    // never fall back to a cheerful default.
    return buzzerEnabled;
}

void setLedMode(uint8_t mode) {
    ledMode = mode > LED_FULL ? LED_FULL : mode;   // the render loop picks it up next tick
    // Outside hwMutex, for the same reason as setBuzzerEnabled(): NVS is slow.
    Preferences prefs;
    if (prefs.begin(BUZZER_NVS_NS, false)) {
        prefs.putUChar("led", ledMode);
        prefs.end();
    } else {
        ESP_LOGW(TAG, "Could not open %s — LED mode will not survive a reboot", BUZZER_NVS_NS);
    }
}

uint8_t getLedMode() {
    return ledMode;
}

void triggerLedFlash(uint8_t r, uint8_t g, uint8_t b, uint32_t durationMs) {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        flashActive = true;
        flashR = r;
        flashG = g;
        flashB = b;
        flashEndTime = millis() + durationMs;
        xSemaphoreGive(hwMutex);
    }
}

void triggerAlarm() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        // Only trigger if not already playing an alarm to prevent infinite sustain
        if (!alarmActive) {
            alarmActive = true;
            alarmEndTime = millis() + 1500; // 1.5 second alarm
        }
        xSemaphoreGive(hwMutex);
    }
}

void triggerWarning() {
    if (hwMutex != NULL && xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        if (!alarmActive) { // Don't override a full alarm
            jingleIndex = 0;
            noteStartTime = 0;
            activeJingle[0] = {800, 150};
            activeJingle[1] = {600, 200};
            jingleLength = 2;
            jinglePlaying = true;
            flashActive = true;
            flashR = 255; flashG = 165; flashB = 0; // Orange
            flashEndTime = millis() + 500;
        }
        xSemaphoreGive(hwMutex);
    }
}

AlertCategory alertCategoryFromName(const char* category) {
    if (!category) return ALERT_GENERIC;
    String c = String(category);
    c.toLowerCase();
    if (c.indexOf("drone") >= 0 || c.indexOf("remote id") >= 0 || c.indexOf("uas") >= 0)
        return ALERT_DRONE;
    if (c.indexOf("track") >= 0 || c.indexOf("airtag") >= 0 || c.indexOf("tile") >= 0 ||
        c.indexOf("tag") >= 0 || c.indexOf("beacon") >= 0)
        return ALERT_TRACKER;
    // ALPR before body cam, because "cam" is a substring of the categories that
    // name BOTH -- "ALPR Camera", "Surveillance Camera". Tested the other way
    // round, those sounded the body-cam pattern and were silenced by the wrong
    // toggle in the app, which is indistinguishable from the mute not working.
    // The shipped defaults ("Flock Safety", "Axon", "Tracker") dodge it, but the
    // signature list is operator-editable and the UI calls this bucket
    // "ALPR / camera". Naming only one of the two still lands where it did.
    if (c.indexOf("flock") >= 0 || c.indexOf("alpr") >= 0 || c.indexOf("plate") >= 0 ||
        c.indexOf("surveil") >= 0)
        return ALERT_ALPR;
    if (c.indexOf("body") >= 0 || c.indexOf("axon") >= 0 || c.indexOf("cam") >= 0)
        return ALERT_BODYCAM;
    return ALERT_GENERIC;
}

void triggerCategoryAlert(AlertCategory cat) {
    if (hwMutex == NULL) return;
    if (xSemaphoreTake(hwMutex, pdMS_TO_TICKS(10)) != pdTRUE) return;
    // One pattern at a time: the category pattern IS a jingle, so an in-flight
    // jingle (or full alarm) owns the buzzer until it finishes. The 1 Hz
    // detector task already rate-limits to one call/sec, so a dense area gets
    // one clear word per second, not an overlapping scream. Must NOT set
    // alarmActive — that flag drives the police-siren tone which runs after the
    // jingle block each loop and would stomp the pattern.
    if (!jinglePlaying && !alarmActive) {
        jingleIndex = 0;
        noteStartTime = 0;
        switch (cat) {
            case ALERT_ALPR:  // two long beeps
                activeJingle[0] = {1200, 250};
                activeJingle[1] = {0, 130};
                activeJingle[2] = {1200, 250};
                jingleLength = 3;
                break;
            case ALERT_BODYCAM:  // long-short-short
                activeJingle[0] = {900, 260};
                activeJingle[1] = {0, 80};
                activeJingle[2] = {900, 90};
                activeJingle[3] = {0, 70};
                activeJingle[4] = {900, 90};
                jingleLength = 5;
                break;
            case ALERT_DRONE:  // rising trill
                activeJingle[0] = {1000, 60};
                activeJingle[1] = {1400, 60};
                activeJingle[2] = {1800, 60};
                activeJingle[3] = {2300, 110};
                jingleLength = 4;
                break;
            case ALERT_TRACKER:  // fast ticking
                activeJingle[0] = {2000, 45};
                activeJingle[1] = {0, 55};
                activeJingle[2] = {2000, 45};
                activeJingle[3] = {0, 55};
                activeJingle[4] = {2000, 45};
                activeJingle[5] = {0, 55};
                activeJingle[6] = {2000, 45};
                jingleLength = 7;
                break;
            case ALERT_GENERIC:
            default:  // plain warning (matched, unknown category)
                activeJingle[0] = {800, 150};
                activeJingle[1] = {600, 200};
                jingleLength = 2;
                break;
        }
        jinglePlaying = true;
        // The bar plays this category's animation (drawAnimation), started with
        // the sound and outlasting it a little. Like the beep pattern, its
        // shape is the ID, so it still reads with the buzzer muted.
        animCat = cat;
        animStart = millis();
    }
    xSemaphoreGive(hwMutex);
}
